// Face regions built from MediaPipe Face Mesh landmark indices.
// "R" / "L" always mean the PATIENT's right / left.

export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
export const EYE_R = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
export const EYE_L = [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249];
export const BROW_R = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
export const BROW_L = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
export const LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
export const NOSTRILS = [64, 98, 97, 2, 326, 327, 294, 278, 344, 440, 275, 4, 45, 220, 115, 48];

export const ZONES = {
  0: null,
  1: 'forehead',
  2: 'nose',
  3: 'cheekR',
  4: 'cheekL',
  5: 'upperLip',
  6: 'chin',
  7: 'other',
};
export const ZONE_LABEL = {
  forehead: 'Forehead',
  nose: 'Nose',
  cheekR: "Right cheek",
  cheekL: "Left cheek",
  upperLip: 'Upper lip',
  chin: 'Chin',
  other: 'Temples / jaw',
};

function scaleAbout(points, k) {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return points.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }));
}

function poly(ctx, points) {
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

/**
 * Rasterise the skin mask (1 = analysable skin) and the zone label map.
 * pts: landmarks already transformed into the w x h working frame.
 */
export function buildRegions(pts, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const P = (ids) => ids.map((i) => pts[i]);
  const eyeW = Math.hypot(pts[33].x - pts[133].x, pts[33].y - pts[133].y) || 20;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  poly(ctx, scaleAbout(P(FACE_OVAL), 0.95));
  ctx.fill();

  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineJoin = 'round';
  for (const ids of [EYE_R, EYE_L]) {
    poly(ctx, scaleAbout(P(ids), 1.45));
    ctx.fill();
    ctx.lineWidth = eyeW * 0.25;
    ctx.stroke();
  }
  for (const ids of [BROW_R, BROW_L]) {
    poly(ctx, P(ids));
    ctx.lineWidth = eyeW * 0.35;
    ctx.fill();
    ctx.stroke();
  }
  poly(ctx, scaleAbout(P(LIPS), 1.08));
  ctx.lineWidth = eyeW * 0.12;
  ctx.fill();
  ctx.stroke();
  poly(ctx, P(NOSTRILS));
  ctx.lineWidth = eyeW * 0.08;
  ctx.fill();
  ctx.stroke();

  const img = ctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = img[i * 4] > 127 ? 1 : 0;

  // ---- zone labels (geometry from landmarks) ----
  const y = (i) => pts[i].y;
  const browTop = Math.min(...[...BROW_R, ...BROW_L].map(y));
  const eyeLow = Math.max(y(145), y(374), y(153), y(380));
  const subnasale = y(2);
  const mouthTop = y(0);
  const lipBottom = y(17);
  const mouthCorner = (y(61) + y(291)) / 2;
  // nose polygon: narrow at the bridge, wide at the alae
  const inR = pts[133], inL = pts[362];
  const br = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const nosePoly = [
    { x: br(inR, inL, 0.3).x, y: y(168) },
    { x: br(inR, inL, 0.7).x, y: y(168) },
    { x: pts[358].x, y: pts[358].y },
    { x: pts[358].x, y: subnasale },
    { x: pts[129].x, y: subnasale },
    { x: pts[129].x, y: pts[129].y },
  ];
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  poly(ctx, nosePoly);
  ctx.fill();
  const nimg = ctx.getImageData(0, 0, w, h).data;

  // midline x as a function of y (line through 168 and 152)
  const m0 = pts[168], m1 = pts[152];
  const midX = (yy) => m0.x + ((m1.x - m0.x) * (yy - m0.y)) / ((m1.y - m0.y) || 1);
  // which image side is the patient's right? landmark 234 is on the patient's right.
  const rightIsLeftInImage = pts[234].x < pts[454].x;
  const xNoseR = pts[129].x, xNoseL = pts[358].x;

  const zone = new Uint8Array(w * h);
  for (let yy = 0; yy < h; yy++) {
    const mx = midX(yy);
    for (let xx = 0; xx < w; xx++) {
      const i = yy * w + xx;
      if (!mask[i]) continue;
      let z = 7;
      if (yy < browTop) z = 1;
      else if (nimg[i * 4] > 127) z = 2;
      else if (yy > lipBottom + eyeW * 0.15) z = 6;
      else if (yy > subnasale && yy < mouthTop + eyeW * 0.1 &&
        Math.abs(xx - mx) < Math.abs(pts[291].x - pts[61].x) * 0.6) z = 5;
      else if (yy > eyeLow + eyeW * 0.2 && yy < mouthCorner + eyeW * 0.3) {
        const onImgLeft = xx < mx;
        const outsideNose = onImgLeft ? xx < Math.min(xNoseR, xNoseL) - eyeW * 0.1
          : xx > Math.max(xNoseR, xNoseL) + eyeW * 0.1;
        if (outsideNose) z = onImgLeft === rightIsLeftInImage ? 3 : 4;
      }
      zone[i] = z;
    }
  }
  return { mask, zone };
}
