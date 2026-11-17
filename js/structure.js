// Facial structure measurements from the front photo landmarks.

const PAIRS = [[33, 263], [133, 362], [61, 291], [234, 454], [172, 397], [58, 288], [132, 361], [93, 323],
  [127, 356], [70, 300], [105, 334], [107, 336], [129, 358], [49, 279], [50, 280], [116, 345], [123, 352],
  [147, 376], [136, 365], [150, 379], [176, 400], [148, 377], [159, 386], [145, 374], [205, 425]];
const MIDLINE = [10, 151, 9, 8, 168, 6, 197, 195, 5, 4, 1, 2, 164, 0, 17, 18, 200, 199, 175, 152];
const DEG = 180 / Math.PI;

function fitMidline(pts) {
  // total-least-squares line through midline landmarks
  const P = MIDLINE.map((i) => pts[i]);
  const mx = P.reduce((s, p) => s + p.x, 0) / P.length;
  const my = P.reduce((s, p) => s + p.y, 0) / P.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of P) { sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; sxy += (p.x - mx) * (p.y - my); }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let dx = Math.cos(ang), dy = Math.sin(ang);
  if (Math.abs(dy) < Math.abs(dx)) { const t = dx; dx = -dy; dy = t; }
  if (dy < 0) { dx = -dx; dy = -dy; }
  return { mx, my, dx, dy }; // direction points down the face
}

export function measureStructure(face) {
  const pts = face.pts;
  const ml = fitMidline(pts);
  // face frame: v = along midline (down), u = across (perpendicular)
  const v = (p) => (p.x - ml.mx) * ml.dx + (p.y - ml.my) * ml.dy;
  const u = (p) => (p.x - ml.mx) * ml.dy - (p.y - ml.my) * ml.dx;
  const P = (i) => pts[i];
  const across = (a, b) => Math.abs(u(P(a)) - u(P(b)));
  const along = (a, b) => Math.abs(v(P(b)) - v(P(a)));
  const stomion = { x: (P(13).x + P(14).x) / 2, y: (P(13).y + P(14).y) / 2 };

  const cheekW = across(234, 454);
  const jawW = across(172, 397);
  const foreheadW = across(21, 251);
  const length = along(10, 152);

  const middle = along(9, 2);
  const lower = along(2, 152);
  const upperLip = Math.abs(v(stomion) - v(P(2)));
  const chinPart = Math.abs(v(P(152)) - v(stomion));
  const upperVerm = along(0, 13);
  const lowerVerm = along(14, 17);

  const eyeR = across(33, 133), eyeL = across(362, 263), inter = across(133, 362);
  const tilt = (medial, lateral) => {
    // positive = outer corner higher than inner corner (relative to the face's horizontal)
    const du = Math.abs(u(P(lateral)) - u(P(medial)));
    const dv = v(P(medial)) - v(P(lateral));
    return Math.atan2(dv, du) * DEG;
  };

  // symmetry: mirror each pair across the midline
  let asym = 0;
  for (const [a, b] of PAIRS) {
    const ua = u(P(a)), va = v(P(a)), ub = u(P(b)), vb = v(P(b));
    asym += Math.hypot(ua + ub, va - vb);
  }
  asym = (asym / PAIRS.length / cheekW) * 100; // % of face width
  const symmetry = Math.max(0, Math.min(100, 100 - asym * 9));

  const LW = length / cheekW, J = jawW / cheekW, F = foreheadW / cheekW;
  let shape = 'Oval';
  if (LW >= 1.42) shape = J >= 0.82 ? 'Rectangular' : 'Oblong';
  else if (J >= 0.82) shape = LW < 1.3 ? 'Square' : 'Rectangular';
  else if (F > J * 1.14 && J < 0.76) shape = 'Heart';
  else if (F < 0.84 && J < 0.78) shape = 'Diamond';
  else if (LW < 1.22) shape = 'Round';

  return {
    midline: ml,
    shape,
    ratios: { lengthToWidth: LW, jawToCheek: J, foreheadToCheek: F },
    thirds: { middle, lower, lowerToMiddle: lower / middle },
    lowerFace: { upperLip, chinPart, ratio: chinPart / upperLip },
    lips: { upper: upperVerm, lower: lowerVerm, ratio: lowerVerm / Math.max(1e-3, upperVerm) },
    fifths: { eyeR, eyeL, inter, interToEye: inter / ((eyeR + eyeL) / 2) },
    canthalTilt: { right: tilt(133, 33), left: tilt(362, 263) },
    symmetry, asymmetryPct: asym,
  };
}

/** Draw the structure overlay; `T(p)` maps photo coords to canvas coords, `k` = scale. */
export function drawStructure(ctx, face, T, k, isFront) {
  const pts = face.pts;
  const P = (i) => T(pts[i]);
  const lw = Math.max(1.5, 2.2 * k * (face.width / 1000));
  ctx.save();
  ctx.lineCap = 'round';
  const line = (a, b, color, dash) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.setLineDash(dash ? [lw * 4, lw * 3] : []);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  };
  // face contour
  const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
    152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = lw;
  ctx.setLineDash([]);
  ctx.beginPath();
  OVAL.forEach((i, n) => { const p = P(i); n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
  ctx.closePath();
  ctx.stroke();

  if (isFront) {
    const s = measureStructure(face);
    const ml = s.midline;
    const off = (i, du) => {
      // point at landmark i's height, shifted across the face by du
      const p = pts[i];
      const vv = (p.x - ml.mx) * ml.dx + (p.y - ml.my) * ml.dy;
      return T({ x: ml.mx + ml.dx * vv + ml.dy * du, y: ml.my + ml.dy * vv - ml.dx * du });
    };
    const half = Math.abs((pts[454].x - pts[234].x)) * 0.62;
    line(off(10, 0), off(152, 0), '#38bdf8', true); // midline
    for (const i of [10, 9, 2, 152]) line(off(i, -half), off(i, half), i === 10 ? 'rgba(250,204,21,0.6)' : '#facc15', i === 10);
    // fifths
    for (const i of [33, 133, 362, 263]) {
      const p = pts[i];
      const a = T({ x: p.x - ml.dx * half * 0.35, y: p.y - ml.dy * half * 0.35 });
      const b = T({ x: p.x + ml.dx * half * 0.35, y: p.y + ml.dy * half * 0.35 });
      line(a, b, '#a78bfa');
    }
    // widths
    line(P(21), P(251), 'rgba(52,211,153,0.9)');
    line(P(234), P(454), 'rgba(52,211,153,0.9)');
    line(P(172), P(397), 'rgba(52,211,153,0.9)');
    // canthal lines
    line(P(133), P(33), '#f472b6');
    line(P(362), P(263), '#f472b6');
  } else {
    // jawline and nose profile on angled views
    const JAW = [234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454];
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = lw * 1.3;
    ctx.beginPath();
    JAW.forEach((i, n) => { const p = P(i); n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
    ctx.stroke();
    ctx.strokeStyle = '#38bdf8';
    ctx.beginPath();
    [10, 151, 9, 168, 6, 197, 195, 5, 4, 1, 2, 0, 17, 18, 200, 152].forEach((i, n) => {
      const p = P(i); n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    });
    ctx.stroke();
  }
  ctx.restore();
}
