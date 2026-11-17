// Builds the 3-photo collage (patient's right 45° | front | patient's left 45°).

import { faceBox } from './face.js';
import { renderView, VIEWS } from './views.js';
import { drawStructure } from './structure.js';

export const SLOTS = [
  { id: 'right', title: "Right side 45°" },
  { id: 'front', title: 'Front' },
  { id: 'left', title: "Left side 45°" },
];

function panelCrop(face) {
  const b = faceBox(face.pts, 0.04);
  let ch = b.h * 1.28, cw = ch * 0.75;
  if (cw < b.w * 1.25) { cw = b.w * 1.25; ch = cw / 0.75; }
  return { x: b.x + b.w / 2 - cw / 2, y: b.y + b.h / 2 - ch / 2 + b.h * 0.02, w: cw, h: ch, box: b };
}

/** Draw one photo panel into ctx at (x, y, pw, ph) with the given view. */
export function drawPanel(ctx, photo, view, x, y, pw, ph) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, pw, ph);
  ctx.clip();
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(x, y, pw, ph);
  if (!photo) {
    ctx.fillStyle = '#5b6573';
    ctx.font = `${Math.round(pw * 0.05)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('No photo', x + pw / 2, y + ph / 2);
    ctx.restore();
    return;
  }
  const crop = panelCrop(photo.face);
  const k = pw / crop.w;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo.source, crop.x, crop.y, crop.w, crop.h, x, y, pw, ph);

  if (view !== 'original' && view !== 'structure' && photo.result) {
    ctx.fillStyle = 'rgba(5,8,12,0.55)';
    ctx.fillRect(x, y, pw, ph);
    const r = photo.result;
    const v = renderView(r, view);
    ctx.drawImage(v, x + (r.box.x - crop.x) * k, y + (r.box.y - crop.y) * k, r.box.w * k, r.box.h * k);
  }
  if (view === 'structure') {
    const T = (p) => ({ x: x + (p.x - crop.x) * k, y: y + (p.y - crop.y) * k });
    drawStructure(ctx, photo.face, T, k, photo.slot === 'front');
  }
  ctx.restore();
}

export function buildCollage(photos, view, info) {
  const pw = 760, ph = Math.round(pw / 0.75), gap = 16, head = 132, foot = 64, side = 24;
  const W = side * 2 + pw * 3 + gap * 2;
  const H = head + ph + foot + side;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const v = VIEWS.find((q) => q.id === view);
  ctx.fillStyle = '#0f172a';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 40px system-ui, -apple-system, sans-serif';
  ctx.fillText(info.clinic || 'Skin consultation', side, 56);
  ctx.font = '28px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#475569';
  const who = [info.patient, info.date].filter(Boolean).join('  ·  ');
  ctx.fillText(who, side, 100);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#0f172a';
  ctx.font = '600 34px system-ui, -apple-system, sans-serif';
  ctx.fillText(v ? v.label : '', W - side, 56);
  ctx.font = '24px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText(v && view !== 'original' ? v.hint : '', W - side, 100);
  ctx.textAlign = 'left';

  SLOTS.forEach((s, n) => {
    const x = side + n * (pw + gap);
    const p = photos[s.id];
    drawPanel(ctx, p, view, x, head, pw, ph);
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 28px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    const ang = p ? `   ${Math.abs(p.face.pose.yaw).toFixed(0)}°` : '';
    ctx.fillText(s.title + ang, x + pw / 2, head + ph + 44);
    ctx.textAlign = 'left';
  });
  return c;
}
