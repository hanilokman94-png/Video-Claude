// On-device skin image analysis.
// Everything here is an *indicative* image measurement for consultation support, not a diagnosis.
//
// Core idea: convert each pixel to optical density (OD) and split it into three parts
// using fixed absorption "colour signatures":
//   melanin     (brown pigment: melasma, spots)      -> absorbs blue >> green > red
//   haemoglobin (redness: vessels, inflammation)     -> absorbs green > blue >> red
//   shading     (light & 3-D shape: pores, scars)   -> darkens all channels equally
// Splitting shading out means a shadow is not mistaken for pigment, and a brown spot
// is not mistaken for an acne scar.

import { faceBox, pxPerMm } from './face.js';
import { buildRegions, ZONES } from './regions.js';

const TARGET_PX_PER_MM = 7; // working resolution (enough for enlarged pores)
const MAX_WORK_PIXELS = 1_900_000;

// Score calibration: tune these after trying the app on a few patients in your clinic light.
export const CALIBRATION = {
  oily: { tzone: 5, cheeks: 3 },          // % shiny area for "Oily"
  combination: { tzone: 3 },              // % T-zone shine for "Combination"
  dry: { tzone: 1, cheeks: 0.7 },         // below these = "Dry-leaning"
  poreDensityPer100: 30,                  // pores / cm² that scores 100
  roughnessBaseline: 60,                  // roughness index regarded as normal skin
  roughnessGain: 1.2,
  scarWeight: 3,                          // score points per detected depression
  pigmentGain: 5, spotWeight: 0.6,
  rednessGain: 5, redSpotWeight: 1.5,
};

// ---------------------------------------------------------------- helpers
function boxPass(src, dst, w, h, r, horizontal) {
  const n = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = horizontal ? 1 : w;
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * w : l;
    let sum = 0, cnt = 0;
    for (let k = 0; k <= Math.min(r, n - 1); k++) { sum += src[base + k * step]; cnt++; }
    for (let k = 0; k < n; k++) {
      dst[base + k * step] = sum / cnt;
      const add = k + r + 1, rem = k - r;
      if (add < n) { sum += src[base + add * step]; cnt++; }
      if (rem >= 0) { sum -= src[base + rem * step]; cnt--; }
    }
  }
}

/** Approximate Gaussian blur (3 box passes each way). */
export function blur(src, w, h, sigma) {
  const out = new Float32Array(src);
  if (sigma < 0.4) return out;
  const r = Math.max(1, Math.round((-1 + Math.sqrt(1 + 4 * sigma * sigma)) / 2));
  const tmp = new Float32Array(src.length);
  for (let p = 0; p < 3; p++) {
    boxPass(out, tmp, w, h, r, true);
    boxPass(tmp, out, w, h, r, false);
  }
  return out;
}

/** Blur that ignores pixels outside `weight` (normalised convolution). */
function blurMasked(v, weight, w, h, sigma) {
  const vw = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) vw[i] = v[i] * weight[i];
  const a = blur(vw, w, h, sigma);
  const b = blur(weight, w, h, sigma);
  for (let i = 0; i < a.length; i++) a[i] = b[i] > 1e-3 ? a[i] / b[i] : 0;
  return a;
}

function quantiles(values, qs) {
  const s = Float32Array.from(values).sort();
  return qs.map((q) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0));
}

function robustStats(arr, mask, stride = 3) {
  const vals = [];
  for (let i = 0; i < arr.length; i += stride) if (mask[i]) vals.push(arr[i]);
  const [q25, med, q75] = quantiles(vals, [0.25, 0.5, 0.75]);
  return { med, sd: Math.max((q75 - q25) / 1.349, 1e-6) };
}

/** 8-connected components of a binary map. */
function components(bin, w, h, zone) {
  const seen = new Uint8Array(bin.length);
  const stack = new Int32Array(bin.length);
  const out = [];
  for (let s = 0; s < bin.length; s++) {
    if (!bin[s] || seen[s]) continue;
    let sp = 0, area = 0, sx = 0, sy = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    const zc = {};
    stack[sp++] = s;
    seen[s] = 1;
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const z = ZONES[zone[i]];
      if (z) zc[z] = (zc[z] || 0) + 1;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (bin[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; }
        }
      }
    }
    let best = null, bc = -1;
    for (const k in zc) if (zc[k] > bc) { bc = zc[k]; best = k; }
    out.push({ area, cx: sx / area, cy: sy / area, bw: x1 - x0 + 1, bh: y1 - y0 + 1, zone: best });
  }
  return out;
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d]
    .map((v) => v / det);
}
// rows: R, G, B ; columns: melanin, haemoglobin, shading
const DECOMP = invert3([0.38, 0.02, 1, 0.62, 1.0, 1, 1.0, 0.6, 1]);

const SRGB_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// ---------------------------------------------------------------- main
/**
 * Analyse one photo.
 * source: canvas / ImageBitmap with the full photo, face: result of detectImage().
 */
export function analysePhoto(source, face) {
  const box = faceBox(face.pts, 0.04);
  const ppmSrc = pxPerMm(face.pts);
  let scale = Math.min(1, TARGET_PX_PER_MM / ppmSrc);
  if (box.w * box.h * scale * scale > MAX_WORK_PIXELS) scale = Math.sqrt(MAX_WORK_PIXELS / (box.w * box.h));
  const w = Math.max(32, Math.round(box.w * scale));
  const h = Math.max(32, Math.round(box.h * scale));
  const ppm = ppmSrc * scale;

  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, box.x, box.y, box.w, box.h, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const pts = face.pts.map((p) => ({ x: (p.x - box.x) * scale, y: (p.y - box.y) * scale, z: p.z * scale }));

  const { mask, zone } = buildRegions(pts, w, h);
  const N = w * h;

  // ---- skin colour gate: drop hair, deep shadow, background leaking into the mask
  const L = new Float32Array(N);
  const cb = new Float32Array(N), cr = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    cb[i] = b - L[i];
    cr[i] = r - L[i];
  }
  const sL = robustStats(L, mask), sCb = robustStats(cb, mask), sCr = robustStats(cr, mask);
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const dc = Math.hypot((cb[i] - sCb.med) / (sCb.sd + 2), (cr[i] - sCr.med) / (sCr.sd + 2));
    if (L[i] < sL.med * 0.42 || dc > 5) { mask[i] = 0; zone[i] = 0; }
  }

  // ---- shine / oil: bright, low-saturation specular highlights above the local skin tone
  const maskF = Float32Array.from(mask);
  // "interior" = at least ~3 mm away from any mask border (eyes, brows, lips, hairline, face edge).
  // Detections are only counted there, so borders are not mistaken for scars or spots.
  const maskBlur = blur(maskF, w, h, Math.max(4, 2.5 * ppm));
  const interior = new Uint8Array(N);
  const feather = new Uint8Array(N);
  const maskSoft = blur(maskF, w, h, 0.8 * ppm);
  for (let i = 0; i < N; i++) {
    interior[i] = mask[i] && maskBlur[i] > 0.985 ? 1 : 0;
    feather[i] = Math.max(0, Math.min(255, ((maskSoft[i] - 0.25) / 0.6) * 255));
  }
  const Lbase = blurMasked(L, maskF, w, h, 5 * ppm);
  const [Lp80] = quantiles(Array.from(L).filter((_, i) => mask[i] && i % 3 === 0), [0.8]);
  const shine = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx ? (mx - mn) / mx : 0;
    if (interior[i] && L[i] > Lbase[i] * 1.13 && L[i] >= Lp80 && sat < 0.42) shine[i] = 1;
  }
  // grow highlights a little and exclude them from colour analysis
  const shineGrow = blur(Float32Array.from(shine), w, h, 0.4 * ppm);
  const valid = new Float32Array(N);
  for (let i = 0; i < N; i++) valid[i] = mask[i] && shineGrow[i] < 0.05 ? 1 : 0;

  // ---- optical density decomposition
  const mel = new Float32Array(N), hb = new Float32Array(N), shd = new Float32Array(N);
  const odR = new Float32Array(N), odG = new Float32Array(N), odB = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    odR[i] = -Math.log(SRGB_LIN[rgba[i * 4]] + 0.004);
    odG[i] = -Math.log(SRGB_LIN[rgba[i * 4 + 1]] + 0.004);
    odB[i] = -Math.log(SRGB_LIN[rgba[i * 4 + 2]] + 0.004);
  }
  const mR = robustStats(odR, valid).med, mG = robustStats(odG, valid).med, mB = robustStats(odB, valid).med;
  const D = DECOMP;
  for (let i = 0; i < N; i++) {
    const r = odR[i] - mR, g = odG[i] - mG, b = odB[i] - mB;
    mel[i] = D[0] * r + D[1] * g + D[2] * b;
    hb[i] = D[3] * r + D[4] * g + D[5] * b;
    shd[i] = D[6] * r + D[7] * g + D[8] * b;
  }

  // smooth chromophore maps a little (sensor noise), ignoring highlights
  const melS = blurMasked(mel, valid, w, h, 0.5 * ppm);
  const hbS = blurMasked(hb, valid, w, h, 0.5 * ppm);
  // remove very slow colour gradients (lighting colour falloff) -> keep features < ~25 mm
  const melBg = blurMasked(mel, valid, w, h, 12 * ppm);
  const hbBg = blurMasked(hb, valid, w, h, 12 * ppm);
  const mStat = robustStats(melS, valid), hStat = robustStats(hbS, valid);
  const melZ = new Float32Array(N), hbZ = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!valid[i]) continue;
    // mix: 70 % local contrast + 30 % global (melasma patches can be large)
    melZ[i] = (0.7 * (melS[i] - melBg[i]) + 0.3 * (melS[i] - mStat.med)) / mStat.sd;
    hbZ[i] = (0.7 * (hbS[i] - hbBg[i]) + 0.3 * (hbS[i] - hStat.med)) / hStat.sd;
  }

  // ---- texture from the shading component (topography: pores, scars, wrinkles)
  const fineA = blurMasked(shd, valid, w, h, Math.max(0.5, 0.08 * ppm));
  const fineB = blurMasked(shd, valid, w, h, 0.6 * ppm);
  const coarseA = blurMasked(shd, valid, w, h, 0.8 * ppm);
  const coarseB = blurMasked(shd, valid, w, h, 3.5 * ppm);
  const pore = new Float32Array(N), relief = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!valid[i]) continue;
    pore[i] = fineA[i] - fineB[i]; // >0 = small dark pit
    relief[i] = coarseA[i] - coarseB[i]; // >0 = shallow depression
  }
  const pStat = robustStats(pore, valid), rStat = robustStats(relief, valid);

  // ---------- thresholds & detections
  const mm2 = ppm * ppm;
  const melBin = new Uint8Array(N), hbBin = new Uint8Array(N), poreBin = new Uint8Array(N), reliefBin = new Uint8Array(N);
  const poreT = pStat.med + Math.max(2.4 * pStat.sd, 0.02);
  const reliefT = rStat.med + Math.max(2.2 * rStat.sd, 0.02);
  for (let i = 0; i < N; i++) {
    if (!valid[i] || !interior[i]) continue;
    if (melZ[i] > 2.0) melBin[i] = 1;
    if (hbZ[i] > 2.0) hbBin[i] = 1;
    if (pore[i] > poreT && melZ[i] < 2.5) poreBin[i] = 1;
    if (relief[i] > reliefT && melZ[i] < 2.0) reliefBin[i] = 1;
  }

  const pores = components(poreBin, w, h, zone).filter(
    (c) => c.area >= Math.max(2, 0.02 * mm2) && c.area <= 0.9 * mm2 && Math.max(c.bw, c.bh) / Math.min(c.bw, c.bh) < 2.6);
  const scars = components(reliefBin, w, h, zone).filter(
    (c) => c.area >= 0.8 * mm2 && c.area <= 20 * mm2 && Math.max(c.bw, c.bh) / Math.min(c.bw, c.bh) < 2.2 &&
      ['cheekR', 'cheekL', 'other', 'forehead', 'chin'].includes(c.zone));
  const pig = components(melBin, w, h, zone).filter((c) => c.area >= 0.8 * mm2);
  const red = components(hbBin, w, h, zone).filter((c) => c.area >= 0.8 * mm2);

  // ---------- per-zone statistics
  const zstat = {};
  for (const k of Object.values(ZONES)) if (k) zstat[k] = { px: 0, valid: 0, shine: 0, mel: 0, hb: 0, rough: 0, rough2: 0 };
  for (let i = 0; i < N; i++) {
    const z = ZONES[zone[i]];
    if (!z || !interior[i]) continue;
    const s = zstat[z];
    s.px++;
    if (shine[i]) s.shine++;
    if (!valid[i]) continue;
    s.valid++;
    if (melBin[i]) s.mel++;
    if (hbBin[i]) s.hb++;
    s.rough += relief[i];
    s.rough2 += relief[i] * relief[i];
  }
  const zones = {};
  for (const [k, s] of Object.entries(zstat)) {
    const areaMm2 = s.px / mm2;
    const mean = s.valid ? s.rough / s.valid : 0;
    zones[k] = {
      areaCm2: areaMm2 / 100,
      shinePct: s.px ? (100 * s.shine) / s.px : 0,
      pigmentPct: s.valid ? (100 * s.mel) / s.valid : 0,
      rednessPct: s.valid ? (100 * s.hb) / s.valid : 0,
      roughness: s.valid ? Math.sqrt(Math.max(0, s.rough2 / s.valid - mean * mean)) * 1000 : 0,
      pores: 0, scars: 0, spots: 0, patchesMm2: 0, redSpots: 0, diffuseRedMm2: 0,
    };
  }
  for (const p of pores) if (p.zone && zones[p.zone]) zones[p.zone].pores++;
  for (const s of scars) if (s.zone && zones[s.zone]) zones[s.zone].scars++;
  for (const c of pig) {
    if (!c.zone || !zones[c.zone]) continue;
    if (c.area / mm2 >= 25) zones[c.zone].patchesMm2 += c.area / mm2;
    else zones[c.zone].spots++;
  }
  const redSpots = [];
  for (const c of red) {
    if (!c.zone || !zones[c.zone]) continue;
    const a = c.area / mm2;
    const round = Math.max(c.bw, c.bh) / Math.min(c.bw, c.bh) < 2;
    if (a <= 20 && round) { zones[c.zone].redSpots++; redSpots.push(c); }
    else if (a > 20) zones[c.zone].diffuseRedMm2 += a;
  }

  // brightness / exposure info for quality warnings
  const exposure = robustStats(L, mask).med;
  const sizeCm2 = Object.values(zones).reduce((s, z) => s + z.areaCm2, 0);

  return {
    w, h, ppm, box, scale, pts,
    rgba, mask, zone, shine, feather,
    melZ, hbZ, pore, relief, shd,
    pores, scars, pig, redSpots,
    zones, exposure, sizeCm2,
    lowRes: ppm < 4.5,
  };
}

// ---------------------------------------------------------------- combine 3 photos
const ZONE_SOURCE = {
  // which photo describes each zone best
  forehead: ['front'], nose: ['front'], upperLip: ['front'], chin: ['front'],
  cheekR: ['right', 'front'], cheekL: ['left', 'front'], other: ['right', 'left', 'front'],
};

function pick(results, zone) {
  for (const v of ZONE_SOURCE[zone]) {
    const r = results[v];
    if (r && r.zones[zone] && r.zones[zone].areaCm2 > 1.5) return r.zones[zone];
  }
  return null;
}

const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const level = (score) => (score < 25 ? 'Minimal' : score < 50 ? 'Mild' : score < 75 ? 'Moderate' : 'Marked');

/**
 * Build the consultation summary from per-photo results {front, right, left}.
 */
export function summarise(results) {
  const Z = {};
  for (const k of Object.keys(ZONE_SOURCE)) Z[k] = pick(results, k);
  const has = (k) => !!Z[k];
  const avg = (keys, f) => {
    const v = keys.filter(has).map((k) => f(Z[k]));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const sum = (keys, f) => keys.filter(has).reduce((s, k) => s + f(Z[k]), 0);
  const areaOf = (keys) => sum(keys, (z) => z.areaCm2) || 1;

  // ---- oil / shine
  const tShine = avg(['forehead', 'nose'], (z) => z.shinePct);
  const cShine = avg(['cheekR', 'cheekL'], (z) => z.shinePct);
  let skinType;
  const C = CALIBRATION;
  if (tShine > C.oily.tzone && cShine > C.oily.cheeks) skinType = 'Oily';
  else if (tShine > C.combination.tzone && cShine < Math.max(1.5, tShine * 0.5)) skinType = 'Combination';
  else if (tShine < C.dry.tzone && cShine < C.dry.cheeks) skinType = 'Dry-leaning';
  else skinType = 'Normal';
  const oilScore = clamp(tShine * 8 + cShine * 10);

  // ---- pores (density per cm² on nose + cheeks)
  const poreKeys = ['nose', 'cheekR', 'cheekL'];
  const poreDensity = sum(poreKeys, (z) => z.pores) / areaOf(poreKeys);
  const poreScore = clamp((poreDensity / C.poreDensityPer100) * 100);

  // ---- texture / acne scars
  const scarKeys = ['cheekR', 'cheekL', 'other'];
  const scarCount = sum(scarKeys, (z) => z.scars);
  const rough = avg(['cheekR', 'cheekL'], (z) => z.roughness);
  const textureScore = clamp(scarCount * C.scarWeight + Math.max(0, rough - C.roughnessBaseline) * C.roughnessGain);

  // ---- pigmentation / melasma
  const pigKeys = ['forehead', 'cheekR', 'cheekL', 'nose', 'upperLip', 'chin'];
  const pigPct = sum(pigKeys, (z) => (z.pigmentPct * z.areaCm2)) / areaOf(pigKeys);
  const patch = (k) => (has(k) ? Z[k].patchesMm2 : 0);
  const spots = sum(pigKeys, (z) => z.spots);
  const bilateral = patch('cheekR') > 40 && patch('cheekL') > 40;
  const centro = patch('forehead') + patch('upperLip') + patch('nose') > 60;
  const melasmaPattern = bilateral ? (centro ? 'Centrofacial + malar' : 'Malar (both cheeks)') : centro ? 'Centrofacial' : null;
  const pigScore = clamp(pigPct * C.pigmentGain + spots * C.spotWeight);

  // ---- redness
  const redKeys = ['forehead', 'cheekR', 'cheekL', 'nose', 'chin'];
  const redPct = sum(redKeys, (z) => z.rednessPct * z.areaCm2) / areaOf(redKeys);
  const redSpots = sum(redKeys, (z) => z.redSpots);
  const redScore = clamp(redPct * C.rednessGain + redSpots * C.redSpotWeight);

  const zoneRows = Object.keys(ZONE_SOURCE).filter(has).map((k) => ({ zone: k, ...Z[k] }));
  const lowRes = Object.values(results).some((r) => r && r.lowRes);

  return {
    skinType, oilScore, tShine, cShine,
    poreScore, poreDensity, poreLevel: level(poreScore),
    textureScore, scarCount, rough, textureLevel: level(textureScore),
    pigScore, pigPct, spots, melasmaPattern, pigLevel: level(pigScore),
    redScore, redPct, redSpots, redLevel: level(redScore),
    zoneRows, lowRes,
  };
}
