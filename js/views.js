// Visual "light modes" rendered from the analysis maps of one photo.

import { blur } from './analysis.js';

export const VIEWS = [
  { id: 'original', label: 'Original', hint: 'Unprocessed photo' },
  { id: 'red', label: 'Red light', hint: 'Red areas: blood vessels, inflammation, active spots' },
  { id: 'blue', label: 'Blue light', hint: 'Surface pigment contrast (melasma, sun spots stand out dark)' },
  { id: 'brown', label: 'Brown spots', hint: 'Melanin map: melasma patches and pigment spots' },
  { id: 'texture', label: 'Pores & texture', hint: 'Relief map: pores (cyan) and possible scars / depressions (orange)' },
  { id: 'shine', label: 'Oil / shine', hint: 'Shiny (oily) areas highlighted in yellow' },
  { id: 'structure', label: 'Face structure', hint: 'Proportions, midline and angles' },
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function renderView(res, view) {
  res._views ??= {};
  if (res._views[view]) return res._views[view];
  const { w, h, rgba, mask } = res;
  const N = w * h;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(w, h);
  const o = out.data;
  const gray = (i) => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const put = (i, r, g, b) => { o[i * 4] = r; o[i * 4 + 1] = g; o[i * 4 + 2] = b; o[i * 4 + 3] = 255; };

  if (view === 'red') {
    for (let i = 0; i < N; i++) {
      const g = gray(i) * 0.5;
      const a = mask[i] ? clamp01((res.hbZ[i] - 0.8) / 2.6) : 0;
      put(i, g * (1 - a) + 255 * a, g * (1 - a) + 30 * a, g * (1 - a) + 45 * a);
    }
  } else if (view === 'brown') {
    for (let i = 0; i < N; i++) {
      const g = gray(i) * 0.5 + 20;
      const a = mask[i] ? clamp01((res.melZ[i] - 0.8) / 2.6) : 0;
      put(i, g * (1 - a) + 120 * a, g * (1 - a) + 62 * a, g * (1 - a) + 20 * a);
    }
  } else if (view === 'blue') {
    // blue channel = where melanin absorbs most; boost local contrast like a blue/UV photo
    const B = new Float32Array(N);
    for (let i = 0; i < N; i++) B[i] = rgba[i * 4 + 2];
    const bg = blur(B, w, h, 6 * res.ppm);
    let s = 0, n = 0;
    for (let i = 0; i < N; i += 7) if (mask[i]) { s += bg[i]; n++; }
    const mean = n ? s / n : 128;
    for (let i = 0; i < N; i++) {
      const v = clamp01((128 + (B[i] - bg[i]) * 3.2 + (bg[i] - mean) * 0.6) / 255);
      put(i, 20 + 90 * v * v, 35 + 170 * v, 70 + 185 * v);
    }
  } else if (view === 'texture') {
    const { relief, pore } = res;
    let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < N; i += 5) if (mask[i]) { const v = relief[i] + pore[i]; s += v; s2 += v * v; n++; }
    const sd = Math.sqrt(Math.max(1e-6, s2 / Math.max(1, n) - (s / Math.max(1, n)) ** 2));
    for (let i = 0; i < N; i++) {
      if (mask[i]) {
        const v = clamp01(0.55 - ((relief[i] + pore[i]) / sd) * 0.13);
        put(i, v * 255, v * 255, v * 255);
      } else {
        const g = gray(i) * 0.35;
        put(i, g, g, g);
      }
    }
  } else if (view === 'shine') {
    for (let i = 0; i < N; i++) {
      const g = gray(i) * 0.55;
      if (res.shine[i]) put(i, 255, 214, 10);
      else put(i, g, g, g);
    }
  } else {
    for (let i = 0; i < N; i++) put(i, rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }
  // only skin is drawn (soft edge); everything else stays transparent over the dimmed photo
  const { feather } = res;
  for (let i = 0; i < N; i++) o[i * 4 + 3] = feather[i];
  ctx.putImageData(out, 0, 0);

  // markers
  const r0 = Math.max(2, res.ppm * 0.6);
  if (view === 'texture') {
    ctx.fillStyle = 'rgba(0, 220, 255, 0.85)';
    for (const p of res.pores) { ctx.beginPath(); ctx.arc(p.cx, p.cy, Math.max(1.5, r0 * 0.5), 0, 7); ctx.fill(); }
    ctx.strokeStyle = 'rgba(255, 140, 0, 0.95)';
    ctx.lineWidth = Math.max(1.5, res.ppm * 0.3);
    for (const s of res.scars) {
      ctx.beginPath();
      ctx.arc(s.cx, s.cy, Math.sqrt(s.area / Math.PI) + r0, 0, 7);
      ctx.stroke();
    }
  } else if (view === 'red') {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = Math.max(1.5, res.ppm * 0.25);
    for (const s of res.redSpots) {
      ctx.beginPath();
      ctx.arc(s.cx, s.cy, Math.sqrt(s.area / Math.PI) + r0 * 1.5, 0, 7);
      ctx.stroke();
    }
  }
  res._views[view] = c;
  return c;
}
