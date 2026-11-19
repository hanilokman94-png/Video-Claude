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

// Score calibration: tune after trying the app on a few patients in your own clinic light.
// Each value is the measurement that gives a score of 100 for that category.
export const CALIBRATION = {
  poresPerCm2: 30,        // visible pores per cm²
  wrinkleMmPerCm2: 40,    // mm of wrinkle line per cm²
  spotPct: 12,            // % of zone covered by defined (surface) spots
  diffusePct: 30,         // % of zone covered by diffuse / deeper pigment
  shinePct: 8,            // % of zone shiny (sebum)
  rednessPct: 18,         // % of zone red
  scarsPerCm2: 2,         // depressions per cm²
  roughnessBaseline: 60,  // normal-skin roughness index (no points below this)
  roughnessGain: 1.2,
  skinType: { oilyT: 5, oilyC: 3, combiT: 3, dryT: 1, dryC: 0.7 },
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

/** 8-connected components of a binary map (with shape moments). */
function components(bin, w, h, zone, labels) {
  const seen = new Uint8Array(bin.length);
  const stack = new Int32Array(bin.length);
  const out = [];
  for (let s = 0; s < bin.length; s++) {
    if (!bin[s] || seen[s]) continue;
    let sp = 0, area = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    const zc = {};
    const id = out.length + 1;
    stack[sp++] = s;
    seen[s] = 1;
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      area++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (labels) labels[i] = id;
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
    const cx = sx / area, cy = sy / area;
    const cxx = sxx / area - cx * cx + 1 / 12, cyy = syy / area - cy * cy + 1 / 12, cxy = sxy / area - cx * cy;
    const tr = (cxx + cyy) / 2, dd = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy);
    const l1 = tr + dd, l2 = Math.max(1e-3, tr - dd);
    out.push({ id, area, cx, cy, bw: x1 - x0 + 1, bh: y1 - y0 + 1, zone: best,
      elong: Math.sqrt(l1 / l2), length: 4 * Math.sqrt(l1) });
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


  // wrinkles: fine linear creases in the shading map
  const wrA = blurMasked(shd, valid, w, h, Math.max(0.6, 0.3 * ppm));
  const wrB = blurMasked(shd, valid, w, h, 1.6 * ppm);
  const wr = new Float32Array(N);
  for (let i = 0; i < N; i++) if (valid[i]) wr[i] = wrA[i] - wrB[i];
  const wStat = robustStats(wr, valid);

  // diffuse / deeper pigment: broad, soft-edged melanin increase (e.g. melasma, dermal pigment)
  const melC = blurMasked(mel, valid, w, h, 2.5 * ppm);
  const cStat = robustStats(melC, valid);
  const melDiffZ = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (valid[i]) melDiffZ[i] = (0.6 * (melC[i] - melBg[i]) + 0.4 * (melC[i] - cStat.med)) / cStat.sd;
  }

  // ---------- thresholds & detections
  const mm2 = ppm * ppm;
  const melBin = new Uint8Array(N), hbBin = new Uint8Array(N), poreBin = new Uint8Array(N);
  const reliefBin = new Uint8Array(N), wrBin = new Uint8Array(N), diffBin = new Uint8Array(N);
  const poreT = pStat.med + Math.max(2.4 * pStat.sd, 0.02);
  const reliefT = rStat.med + Math.max(2.2 * rStat.sd, 0.02);
  const wrT = wStat.med + Math.max(2.0 * wStat.sd, 0.015);
  for (let i = 0; i < N; i++) {
    if (!valid[i] || !interior[i]) continue;
    if (melZ[i] > 2.0) melBin[i] = 1;
    if (melDiffZ[i] > 1.6) diffBin[i] = 1;
    if (hbZ[i] > 2.0) hbBin[i] = 1;
    if (pore[i] > poreT && melZ[i] < 2.5) poreBin[i] = 1;
    if (relief[i] > reliefT && melZ[i] < 2.0) reliefBin[i] = 1;
    if (wr[i] > wrT && zone[i] !== 2 && zone[i] !== 5) wrBin[i] = 1;
  }

  const ratio = (c) => Math.max(c.bw, c.bh) / Math.min(c.bw, c.bh);
  const pores = components(poreBin, w, h, zone).filter(
    (c) => c.area >= Math.max(2, 0.02 * mm2) && c.area <= 0.9 * mm2 && ratio(c) < 2.6);
  const scars = components(reliefBin, w, h, zone).filter(
    (c) => c.area >= 0.8 * mm2 && c.area <= 20 * mm2 && ratio(c) < 2.2 && c.elong < 2.5 &&
      ['cheekR', 'cheekL', 'other', 'forehead', 'chin'].includes(c.zone));

  const wrLabels = new Int32Array(N);
  const wrComps = components(wrBin, w, h, zone, wrLabels);
  const wrinkles = wrComps.filter((c) => c.elong >= 3 && c.length >= 4 * ppm && c.area >= 6);
  const wrKeep = new Uint8Array(wrComps.length + 1);
  for (const c of wrinkles) wrKeep[c.id] = 1;
  const wrinkleMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (wrLabels[i] && wrKeep[wrLabels[i]]) wrinkleMask[i] = 1;

  const spotLabels = new Int32Array(N);
  const spotComps = components(melBin, w, h, zone, spotLabels);
  const spots = spotComps.filter((c) => c.area >= 0.8 * mm2 && c.area < 25 * mm2);
  const spotKeep = new Uint8Array(spotComps.length + 1);
  for (const c of spots) spotKeep[c.id] = 1;
  const spotMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (spotLabels[i] && spotKeep[spotLabels[i]]) spotMask[i] = 1;

  const diffLabels = new Int32Array(N);
  const diffComps = components(diffBin, w, h, zone, diffLabels);
  const patches = diffComps.filter((c) => c.area >= 15 * mm2);
  const diffKeep = new Uint8Array(diffComps.length + 1);
  for (const c of patches) diffKeep[c.id] = 1;
  const diffuseMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (diffLabels[i] && diffKeep[diffLabels[i]]) diffuseMask[i] = 1;

  const red = components(hbBin, w, h, zone).filter((c) => c.area >= 0.8 * mm2);
  const redSpots = red.filter((c) => c.area / mm2 <= 20 && ratio(c) < 2);

  // ---------- per-zone statistics
  const zstat = {};
  for (const k of Object.values(ZONES)) {
    if (k) zstat[k] = { px: 0, valid: 0, shine: 0, spot: 0, diff: 0, hb: 0, rough: 0, rough2: 0, r: 0, g: 0, b: 0 };
  }
  for (let i = 0; i < N; i++) {
    const z = ZONES[zone[i]];
    if (!z || !interior[i]) continue;
    const s = zstat[z];
    s.px++;
    if (shine[i]) s.shine++;
    if (!valid[i]) continue;
    s.valid++;
    if (spotMask[i]) s.spot++;
    if (diffuseMask[i]) s.diff++;
    if (hbBin[i]) s.hb++;
    s.rough += relief[i];
    s.rough2 += relief[i] * relief[i];
    s.r += rgba[i * 4]; s.g += rgba[i * 4 + 1]; s.b += rgba[i * 4 + 2];
  }
  const zones = {};
  for (const [k, s] of Object.entries(zstat)) {
    const mean = s.valid ? s.rough / s.valid : 0;
    zones[k] = {
      areaCm2: s.px / mm2 / 100,
      shinePct: s.px ? (100 * s.shine) / s.px : 0,
      spotPct: s.valid ? (100 * s.spot) / s.valid : 0,
      diffusePct: s.valid ? (100 * s.diff) / s.valid : 0,
      rednessPct: s.valid ? (100 * s.hb) / s.valid : 0,
      roughness: s.valid ? Math.sqrt(Math.max(0, s.rough2 / s.valid - mean * mean)) * 1000 : 0,
      rgb: s.valid ? [s.r / s.valid, s.g / s.valid, s.b / s.valid] : null,
      pores: 0, scars: 0, spots: 0, patchesMm2: 0, redSpots: 0, wrinkleMm: 0,
    };
  }
  const add = (list, key, f = () => 1) => { for (const c of list) if (c.zone && zones[c.zone]) zones[c.zone][key] += f(c); };
  add(pores, 'pores');
  add(scars, 'scars');
  add(spots, 'spots');
  add(patches, 'patchesMm2', (c) => c.area / mm2);
  add(redSpots, 'redSpots');
  add(wrinkles, 'wrinkleMm', (c) => c.length / ppm);

  const exposure = robustStats(L, mask).med;

  return {
    w, h, ppm, box, scale, pts,
    mask, zone, shine, feather,
    melZ, melDiffZ, hbZ, pore, relief, wr,
    pores, scars, redSpots, wrinkles, spots, patches,
    wrinkleMask, spotMask, diffuseMask,
    zones, exposure,
    lowRes: ppm < 4.5,
  };
}

// ---------------------------------------------------------------- colour helpers
function srgbToLab([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return { L: 116 * f(Y) - 16, a: 500 * (f(X) - f(Y)), b: 200 * (f(Y) - f(Z)) };
}

function itaCategory(ita) {
  if (ita > 55) return 'Very light';
  if (ita > 41) return 'Light';
  if (ita > 28) return 'Intermediate';
  if (ita > 10) return 'Tan';
  if (ita > -30) return 'Brown';
  return 'Dark';
}

// ---------------------------------------------------------------- combine 3 photos
const ZONE_SOURCE = {
  // which photo describes each zone best
  forehead: ['front'], nose: ['front'], upperLip: ['front'], chin: ['front'], eyes: ['front'],
  cheekR: ['right', 'front'], cheekL: ['left', 'front'], other: ['right', 'left', 'front'],
};

export const CATEGORIES = [
  { id: 'pores', label: 'Pores', zones: ['nose', 'cheekR', 'cheekL', 'forehead', 'chin'] },
  { id: 'wrinkles', label: 'Wrinkles', zones: ['forehead', 'eyes', 'cheekR', 'cheekL'] },
  { id: 'spots', label: 'Spots (surface)', zones: ['forehead', 'cheekR', 'cheekL', 'nose', 'eyes', 'upperLip', 'chin'] },
  { id: 'deep', label: 'Deep / diffuse pigment', zones: ['forehead', 'cheekR', 'cheekL', 'nose', 'eyes', 'upperLip', 'chin'] },
  { id: 'sebum', label: 'Sebum (oil)', zones: ['forehead', 'nose', 'cheekR', 'cheekL', 'chin'] },
  { id: 'redness', label: 'Redness', zones: ['forehead', 'nose', 'cheekR', 'cheekL', 'chin'] },
  { id: 'texture', label: 'Texture & scars', zones: ['cheekR', 'cheekL', 'forehead', 'chin', 'other'] },
];

const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
export const level = (score) => (score < 25 ? 'Minimal' : score < 50 ? 'Mild' : score < 75 ? 'Moderate' : 'Marked');

function zoneScore(cat, z) {
  const C = CALIBRATION;
  const a = Math.max(0.5, z.areaCm2);
  switch (cat) {
    case 'pores': return clamp((z.pores / a / C.poresPerCm2) * 100);
    case 'wrinkles': return clamp((z.wrinkleMm / a / C.wrinkleMmPerCm2) * 100);
    case 'spots': return clamp((z.spotPct / C.spotPct) * 100);
    case 'deep': return clamp((z.diffusePct / C.diffusePct) * 100);
    case 'sebum': return clamp((z.shinePct / C.shinePct) * 100);
    case 'redness': return clamp((z.rednessPct / C.rednessPct) * 100 + (z.redSpots / a) * 15);
    case 'texture': return clamp((z.scars / a / C.scarsPerCm2) * 100 * 0.6 +
      Math.max(0, z.roughness - C.roughnessBaseline) * C.roughnessGain);
    default: return 0;
  }
}

/**
 * Build the consultation summary from per-photo results {front, right, left}.
 * The returned object only holds plain numbers/strings so it can be saved with the visit.
 */
export function summarise(results) {
  const Z = {};
  for (const k of Object.keys(ZONE_SOURCE)) {
    for (const v of ZONE_SOURCE[k]) {
      const r = results[v];
      if (r && r.zones[k] && r.zones[k].areaCm2 > 1) { Z[k] = r.zones[k]; break; }
    }
  }
  const has = (k) => !!Z[k];

  const cats = {};
  for (const c of CATEGORIES) {
    const zs = {};
    let sum = 0, wsum = 0;
    for (const k of c.zones) {
      if (!has(k)) continue;
      const sc = zoneScore(c.id, Z[k]);
      zs[k] = Math.round(sc);
      sum += sc * Z[k].areaCm2;
      wsum += Z[k].areaCm2;
    }
    const score = wsum ? sum / wsum : 0;
    cats[c.id] = { score: Math.round(score), level: level(score), zones: zs };
  }

  // skin type from shine
  const avg = (keys, f) => {
    const v = keys.filter(has).map((k) => f(Z[k]));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const T = CALIBRATION.skinType;
  const tShine = avg(['forehead', 'nose'], (z) => z.shinePct);
  const cShine = avg(['cheekR', 'cheekL'], (z) => z.shinePct);
  let skinType;
  if (tShine > T.oilyT && cShine > T.oilyC) skinType = 'Oily';
  else if (tShine > T.combiT && cShine < Math.max(1.5, tShine * 0.5)) skinType = 'Combination';
  else if (tShine < T.dryT && cShine < T.dryC) skinType = 'Dry-leaning';
  else skinType = 'Normal';

  // pigment pattern
  const patch = (k) => (has(k) ? Z[k].patchesMm2 : 0);
  const bilateral = patch('cheekR') > 40 && patch('cheekL') > 40;
  const centro = patch('forehead') + patch('upperLip') + patch('nose') > 60;
  const melasmaPattern = bilateral ? (centro ? 'Centrofacial + malar' : 'Malar (both cheeks)') : centro ? 'Centrofacial' : null;

  // skin tone
  const toneKeys = ['forehead', 'cheekR', 'cheekL', 'chin'].filter((k) => has(k) && Z[k].rgb);
  const labs = toneKeys.map((k) => ({ k, lab: srgbToLab(Z[k].rgb), rgb: Z[k].rgb }));
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const Ls = mean(labs.map((x) => x.lab.L)), bs = mean(labs.map((x) => x.lab.b));
  const ita = (Math.atan2(Ls - 50, bs) * 180) / Math.PI;
  const evenness = labs.length > 1 ? Math.sqrt(mean(labs.map((x) => (x.lab.L - Ls) ** 2))) : 0;
  const eyeL = has('eyes') && Z.eyes.rgb ? srgbToLab(Z.eyes.rgb).L : null;
  const cheekL = mean(labs.filter((x) => x.k.startsWith('cheek')).map((x) => x.lab.L)) || Ls;
  const repRgb = labs.length ? [0, 1, 2].map((i) => Math.round(mean(labs.map((x) => x.rgb[i])))) : [180, 150, 130];
  const tone = {
    brightness: Math.round(Ls), // L*: 0 black .. 100 white
    ita: Math.round(ita),
    category: itaCategory(ita),
    evenness: +evenness.toFixed(1),
    underEyeDiff: eyeL == null ? null : +(cheekL - eyeL).toFixed(1),
    rgb: repRgb,
    zones: Object.fromEntries(labs.map((x) => [x.k, { L: Math.round(x.lab.L), rgb: x.rgb.map(Math.round) }])),
  };

  const zoneRows = Object.keys(ZONE_SOURCE).filter(has).map((k) => ({
    zone: k,
    areaCm2: +Z[k].areaCm2.toFixed(1),
    pores: Z[k].pores, wrinkleMm: Math.round(Z[k].wrinkleMm), spots: Z[k].spots, scars: Z[k].scars,
    shinePct: +Z[k].shinePct.toFixed(1), spotPct: +Z[k].spotPct.toFixed(1),
    diffusePct: +Z[k].diffusePct.toFixed(1), rednessPct: +Z[k].rednessPct.toFixed(1),
  }));

  return {
    cats, skinType, tShine: +tShine.toFixed(1), cShine: +cShine.toFixed(1),
    melasmaPattern, tone, zoneRows,
    lowRes: Object.values(results).some((r) => r && r.lowRes),
  };
}
