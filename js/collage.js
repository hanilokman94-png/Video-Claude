// 3-angle collage (patient's right 45° | front | patient's left 45°) and single panels.

import { renderImage, photoCrop } from './views.js';
import { drawStructure } from './structure.js';

export const SLOTS = [
  { id: 'right', title: 'Right 45°' },
  { id: 'front', title: 'Front' },
  { id: 'left', title: 'Left 45°' },
];

/** Draw one photo into ctx at (x, y, pw, ph). mode 'STRUCT' draws the structure overlay. */
export function drawPanel(ctx, photo, light, mode, x, y, pw, ph) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, pw, ph);
  ctx.clip();
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(x, y, pw, ph);
  if (!photo) {
    ctx.fillStyle = '#5b6573';
    ctx.font = `${Math.round(pw * 0.06)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('No photo', x + pw / 2, y + ph / 2);
    ctx.restore();
    return;
  }
  const struct = mode === 'STRUCT';
  const img = renderImage(photo, struct ? 'N' : light, struct ? '' : mode, Math.max(ph, 400));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x, y, pw, ph);
  if (struct) {
    const crop = photoCrop(photo);
    const k = pw / crop.w;
    const T = (p) => ({ x: x + (p.x - crop.x) * k, y: y + (p.y - crop.y) * k });
    drawStructure(ctx, photo.face, T, k, photo.slot === 'front');
  }
  ctx.restore();
}

export function buildCollage(photos, light, mode, info, title) {
  const pw = 760, ph = Math.round(pw / 0.75), gap = 16, head = 132, foot = 64, side = 24;
  const W = side * 2 + pw * 3 + gap * 2;
  const H = head + ph + foot + side;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#0f172a';
  ctx.font = '600 40px system-ui, -apple-system, sans-serif';
  ctx.fillText(info.clinic || 'Skin consultation', side, 56);
  ctx.font = '28px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#475569';
  ctx.fillText([info.patient, info.date].filter(Boolean).join('  ·  '), side, 100);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#0f172a';
  ctx.font = '600 34px system-ui, -apple-system, sans-serif';
  ctx.fillText(title || '', W - side, 56);
  ctx.textAlign = 'left';

  SLOTS.forEach((s, n) => {
    const x = side + n * (pw + gap);
    const p = photos[s.id];
    drawPanel(ctx, p, light, mode, x, head, pw, ph);
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 28px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    const ang = p ? `   (${Math.abs(p.face.pose.yaw).toFixed(0)}°)` : '';
    ctx.fillText(s.title + ang, x + pw / 2, head + ph + 44);
    ctx.textAlign = 'left';
  });
  return c;
}
