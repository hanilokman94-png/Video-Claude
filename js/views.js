// Image renderer: the three "light" images and their M (marked) / B (black & white) modes.
//
//  N  Normal light        M = pores (cyan) & wrinkles (yellow)      B = relief map
//  P  Polarized-style     M = surface spots (orange)               B = melanin map
//  U  UV-style            M = deep/diffuse pigment (F, magenta)     B = UV black & white
//                             or sebum (S, white-cyan)
//
// P and U are computed from a normal photo (gloss suppressed / blue channel enhanced).
// They imitate what those lights help you see; they are not real polarised or UV photographs.

import { blur } from './analysis.js';
import { faceBox } from './face.js';
import { ZONES, ZONE_LETTER } from './regions.js';

export const LIGHTS = {
  N: { label: 'Normal', sub: 'Pores & wrinkles', fns: [{ id: 'PW', label: 'P.W' }] },
  P: { label: 'Polarized-style', sub: 'Surface spots', fns: [{ id: 'F', label: 'F' }] },
  U: { label: 'UV-style', sub: 'Deep spots & sebum', fns: [{ id: 'F', label: 'F' }, { id: 'S', label: 'S' }] },
};

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 3:4 crop around the face, in source-photo pixels. */
export function photoCrop(photo) {
  if (photo._crop) return photo._crop;
  const b = faceBox(photo.face.pts, 0.04);
  let ch = b.h * 1.28, cw = ch * 0.75;
  if (cw < b.w * 1.25) { cw = b.w * 1.25; ch = cw / 0.75; }
  photo._crop = { x: b.x + b.w / 2 - cw / 2, y: b.y + b.h / 2 - ch / 2 + b.h * 0.02, w: cw, h: ch };
  return photo._crop;
}

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Crop of the original photo at render scale. */
function baseNormal(photo, s) {
  const crop = photoCrop(photo);
  const c = newCanvas(crop.w * s, crop.h * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo.source, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
  return c;
}

function pixelMap(src, fn) {
  const ctx = src.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, src.width, src.height);
  fn(img.data, src.width, src.height);
  const c = newCanvas(src.width, src.height);
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

/** "Polarized-style": suppress surface gloss, lift pigment & vessel contrast. */
function basePolar(n) {
  return pixelMap(n, (d) => {
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      // soft knee on highlights (gloss)
      const knee = 175;
      const lt = l > knee ? knee + (l - knee) * 0.25 : l;
      const k = l > 1 ? lt / l : 1;
      r *= k; g *= k; b *= k;
      // saturation & contrast
      const m = (r + g + b) / 3;
      r = m + (r - m) * 1.22; g = m + (g - m) * 1.22; b = m + (b - m) * 1.22;
      d[i] = clamp255((r - 128) * 1.08 + 128 - 4);
      d[i + 1] = clamp255((g - 128) * 1.08 + 128 - 4);
      d[i + 2] = clamp255((b - 128) * 1.08 + 128 - 2);
    }
  });
}

/** "UV-style": blue channel (strongly absorbed by melanin) with local contrast, violet tint. */
function baseUV(n, gray = false) {
  const w = n.width, h = n.height;
  const d0 = n.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const B = new Float32Array(w * h);
  for (let i = 0; i < B.length; i++) B[i] = 0.75 * d0[i * 4 + 2] + 0.25 * d0[i * 4 + 1];
  const bg = blur(B, w, h, w / 45);
  let s = 0;
  for (let i = 0; i < B.length; i += 11) s += bg[i];
  const mean = s / Math.ceil(B.length / 11);
  return pixelMap(n, (d) => {
    for (let i = 0; i < B.length; i++) {
      const v = clamp01((118 + (B[i] - bg[i]) * 2.8 + (bg[i] - mean) * 0.55) / 255);
      const j = i * 4;
      if (gray) { d[j] = d[j + 1] = d[j + 2] = 255 * v; }
      else {
        d[j] = 25 + 120 * v * v;
        d[j + 1] = 20 + 150 * v;
        d[j + 2] = 60 + 195 * v;
      }
    }
  });
}

function dimGray(src, k = 0.45) {
  return pixelMap(src, (d) => {
    for (let i = 0; i < d.length; i += 4) {
      const g = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * k;
      d[i] = d[i + 1] = d[i + 2] = g;
    }
  });
}

/** Build an RGBA overlay at analysis resolution. fn(i) -> [r,g,b,a] or null */
function overlay(res, fn) {
  const c = newCanvas(res.w, res.h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(res.w, res.h);
  const o = img.data;
  for (let i = 0; i < res.w * res.h; i++) {
    const v = fn(i);
    if (!v) continue;
    o[i * 4] = v[0]; o[i * 4 + 1] = v[1]; o[i * 4 + 2] = v[2]; o[i * 4 + 3] = v[3];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Map analysis-pixel coordinates to the rendered crop canvas. */
export function a2c(photo, s) {
  const r = photo.result, crop = photoCrop(photo);
  return {
    x: (ax) => (r.box.x + ax / r.scale - crop.x) * s,
    y: (ay) => (r.box.y + ay / r.scale - crop.y) * s,
    k: s / r.scale,
  };
}

function drawOverlay(ctx, photo, s, ov) {
  const r = photo.result, crop = photoCrop(photo);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(ov, (r.box.x - crop.x) * s, (r.box.y - crop.y) * s, r.box.w * s, r.box.h * s);
}

function zoneCentres(res) {
  if (res._zc) return res._zc;
  const acc = {};
  for (let i = 0; i < res.w * res.h; i++) {
    const z = ZONES[res.zone[i]];
    if (!z || !res.mask[i]) continue;
    const a = (acc[z] ??= { x: 0, y: 0, n: 0 });
    a.x += i % res.w; a.y += (i / res.w) | 0; a.n++;
  }
  res._zc = Object.fromEntries(Object.entries(acc).filter(([, a]) => a.n > 200).map(([k, a]) => [k, { x: a.x / a.n, y: a.y / a.n }]));
  return res._zc;
}

const ZONE_COLOR = {
  forehead: [56, 189, 248], nose: [250, 204, 21], cheekR: [52, 211, 153], cheekL: [167, 139, 250],
  eyes: [244, 114, 182], chin: [251, 146, 60], upperLip: [248, 113, 113], other: [148, 163, 184],
};

/**
 * Render one image.
 * light: 'N' | 'P' | 'U'
 * mode : '' (plain) | 'PW' | 'F' | 'S' (M = marked) | 'B' (black & white)
 *        or analysis views: 'RED' | 'TEX' | 'SEB' | 'ZONES'
 * maxH : output height cap (pixels)
 */
export function renderImage(photo, light = 'N', mode = '', maxH = 1600) {
  const crop = photoCrop(photo);
  const s = Math.min(1, maxH / crop.h);
  const key = `${light}|${mode}|${Math.round(s * 1000)}`;
  photo._cache ??= {};
  if (photo._cache[key]) return photo._cache[key];

  const baseKey = `base|${light}|${Math.round(s * 1000)}`;
  let base = photo._cache[baseKey];
  if (!base) {
    const n = photo._cache[`base|N|${Math.round(s * 1000)}`] || baseNormal(photo, s);
    photo._cache[`base|N|${Math.round(s * 1000)}`] = n;
    base = light === 'P' ? basePolar(n) : light === 'U' ? baseUV(n) : n;
    photo._cache[baseKey] = base;
  }
  if (!mode) return base;

  const r = photo.result;
  const out = newCanvas(base.width, base.height);
  const ctx = out.getContext('2d');
  if (!r) { ctx.drawImage(base, 0, 0); return out; }
  const map = a2c(photo, s);
  const dot = Math.max(1.6, r.ppm * 0.35 * map.k);

  if (mode === 'B' || mode === 'TEX') {
    // black & white feature map on skin, dimmed grey elsewhere
    ctx.drawImage(dimGray(base, 0.35), 0, 0);
    let ov;
    if (light === 'N' || mode === 'TEX') {
      let s1 = 0, s2 = 0, n = 0;
      for (let i = 0; i < r.w * r.h; i += 5) if (r.mask[i]) { const v = r.relief[i] + r.pore[i] + r.wr[i]; s1 += v; s2 += v * v; n++; }
      const sd = Math.sqrt(Math.max(1e-8, s2 / Math.max(1, n) - (s1 / Math.max(1, n)) ** 2));
      ov = overlay(r, (i) => {
        if (!r.feather[i]) return null;
        const v = 255 * clamp01(0.62 - ((r.relief[i] + r.pore[i] + r.wr[i]) / sd) * 0.14);
        return [v, v, v, r.feather[i]];
      });
    } else if (light === 'P') {
      ov = overlay(r, (i) => {
        if (!r.feather[i]) return null;
        const v = 255 * clamp01(0.8 - r.melZ[i] * 0.12);
        return [v, v, v, r.feather[i]];
      });
    } else {
      const g = baseUV(baseNormal(photo, s), true);
      ctx.drawImage(g, 0, 0);
      ov = overlay(r, (i) => (r.diffuseMask[i] ? [20, 20, 20, 150] : null));
    }
    drawOverlay(ctx, photo, s, ov);
    if (mode === 'TEX') {
      ctx.strokeStyle = 'rgba(255,140,0,0.95)';
      ctx.lineWidth = Math.max(2, r.ppm * 0.3 * map.k);
      for (const sc of r.scars) {
        ctx.beginPath();
        ctx.arc(map.x(sc.cx), map.y(sc.cy), (Math.sqrt(sc.area / Math.PI) + r.ppm) * map.k, 0, 7);
        ctx.stroke();
      }
    }
  } else if (mode === 'RED') {
    ctx.drawImage(dimGray(base, 0.55), 0, 0);
    drawOverlay(ctx, photo, s, overlay(r, (i) => {
      if (!r.feather[i]) return null;
      const a = clamp01((r.hbZ[i] - 0.8) / 2.6);
      return a > 0.02 ? [255, 30, 45, a * 230 * (r.feather[i] / 255)] : null;
    }));
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = Math.max(2, r.ppm * 0.25 * map.k);
    for (const sp of r.redSpots) {
      ctx.beginPath();
      ctx.arc(map.x(sp.cx), map.y(sp.cy), (Math.sqrt(sp.area / Math.PI) + r.ppm) * map.k, 0, 7);
      ctx.stroke();
    }
  } else if (mode === 'ZONES') {
    ctx.drawImage(base, 0, 0);
    drawOverlay(ctx, photo, s, overlay(r, (i) => {
      const z = ZONES[r.zone[i]];
      if (!z || !r.mask[i]) return null;
      const c = ZONE_COLOR[z];
      return [c[0], c[1], c[2], 70];
    }));
    const zc = zoneCentres(r);
    const fs = Math.max(14, base.width / 22);
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [z, p] of Object.entries(zc)) {
      if (z === 'other' || z === 'upperLip') continue;
      const x = map.x(p.x), y = map.y(p.y);
      ctx.fillStyle = 'rgba(15,23,42,0.75)';
      ctx.beginPath(); ctx.arc(x, y, fs * 0.8, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(ZONE_LETTER[z], x, y + 1);
    }
  } else {
    // M modes: base image + coloured marks
    ctx.drawImage(base, 0, 0);
    if (light === 'N') {
      drawOverlay(ctx, photo, s, overlay(r, (i) => (r.wrinkleMask[i] ? [255, 221, 0, 235] : null)));
      ctx.fillStyle = 'rgba(0,229,255,0.9)';
      for (const p of r.pores) { ctx.beginPath(); ctx.arc(map.x(p.cx), map.y(p.cy), dot, 0, 7); ctx.fill(); }
    } else if (light === 'P') {
      drawOverlay(ctx, photo, s, overlay(r, (i) => (r.spotMask[i] ? [255, 120, 0, 215] : null)));
    } else if (light === 'U' && mode === 'F') {
      drawOverlay(ctx, photo, s, overlay(r, (i) => {
        if (!r.diffuseMask[i]) return null;
        return [236, 72, 236, 150 + Math.min(80, r.melDiffZ[i] * 20)];
      }));
    } else if (light === 'U' && mode === 'S') {
      drawOverlay(ctx, photo, s, overlay(r, (i) => (r.shine[i] ? [190, 255, 255, 240] : null)));
    }
  }
  photo._cache[key] = out;
  return out;
}

export function clearRenderCache(photo) {
  photo._cache = {};
}
