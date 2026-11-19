// Full-screen image viewer: pinch-zoom, navigator, "hold for original" lamp,
// and measurement / drawing tools (length, area, angle, line profile, arrow, text, pen).
// Annotations are stored in source-photo pixel coordinates.

import { renderImage, photoCrop, LIGHTS } from './views.js';
import { pxPerMm } from './face.js';

const $ = (s) => document.querySelector(s);
const TOOLS = [
  { id: 'pan', label: '✋ Move' },
  { id: 'length', label: '📏 Length' },
  { id: 'area', label: '◯ Area' },
  { id: 'angle', label: '∠ Angle' },
  { id: 'profile', label: '〰 Profile' },
  { id: 'arrow', label: '➚ Arrow' },
  { id: 'text', label: 'T Text' },
  { id: 'pen', label: '✎ Pen' },
];
const COLORS = ['#ffffff', '#facc15', '#ef4444', '#22d3ee', '#22c55e'];

let V = null; // viewer state

export function openViewer(opts) {
  // opts: { photo, light, mode, title, annotations: [], onChange(), modes: true }
  V = {
    ...opts,
    tool: 'pan',
    color: COLORS[1],
    z: 1, tx: 0, ty: 0,
    pointers: new Map(),
    draft: null,
    lamp: false,
    profile: null,
  };
  V.annotations ??= [];
  V.ppm = pxPerMm(V.photo.face.pts);
  buildUI();
  $('#viewer').hidden = false;
  document.body.classList.add('noscroll');
  loadImage();
  requestAnimationFrame(() => { fit(); draw(); });
}

export function closeViewer() {
  if (!V) return;
  $('#viewer').hidden = true;
  document.body.classList.remove('noscroll');
  window.removeEventListener('resize', onResize);
  V = null;
}

function loadImage() {
  V.img = renderImage(V.photo, V.light, V.mode, 2400);
  V.plain = renderImage(V.photo, 'N', '', 2400);
  const crop = photoCrop(V.photo);
  V.s = V.img.width / crop.w;
  V.crop = crop;
}

// ------------------------------------------------------------ UI
function buildUI() {
  const el = $('#viewer');
  el.innerHTML = `
    <div class="vw-top">
      <div class="vw-title">${V.title || ''}</div>
      <div class="vw-modes" id="vwModes"></div>
      <button class="btn small ghost-dark" id="vwClose">✕ Close</button>
    </div>
    <div class="vw-stage" id="vwStage"><canvas id="vwCanvas"></canvas>
      <canvas id="vwNav" class="vw-nav"></canvas>
      <div class="vw-profile" id="vwProfile" hidden></div>
      <div class="vw-hint" id="vwHint"></div>
    </div>
    <div class="vw-tools">
      <div class="vw-toolset" id="vwTools"></div>
      <div class="vw-colors" id="vwColors"></div>
      <div class="vw-actions">
        <button class="btn small ghost-dark" id="vwLamp" title="Hold to see the original photo">💡 Hold: original</button>
        <button class="btn small ghost-dark" id="vwUndo">↶ Undo</button>
        <button class="btn small ghost-dark" id="vwClear">Clear</button>
        <button class="btn small ghost-dark" id="vwFit">Fit</button>
        <button class="btn small primary" id="vwSave">Save image</button>
      </div>
    </div>`;

  if (V.modes !== false) {
    const m = $('#vwModes');
    for (const [L, def] of Object.entries(LIGHTS)) {
      const g = document.createElement('div');
      g.className = 'vw-mgroup';
      const opts = [['', L], ...def.fns.map((f) => [f.id, `${L}+${f.label}`]), ['B', `${L}+B`]];
      for (const [mode, label] of opts) {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = V.light === L && V.mode === mode ? 'on' : '';
        b.addEventListener('click', () => {
          V.light = L; V.mode = mode;
          loadImage(); draw();
          [...m.querySelectorAll('button')].forEach((x) => x.classList.toggle('on', x === b));
          V.onModeChange?.(L, mode);
        });
        g.appendChild(b);
      }
      m.appendChild(g);
    }
  }

  const tools = $('#vwTools');
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.textContent = t.label;
    b.dataset.tool = t.id;
    b.className = t.id === V.tool ? 'on' : '';
    b.addEventListener('click', () => setTool(t.id));
    tools.appendChild(b);
  }
  const cols = $('#vwColors');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.style.background = c;
    b.className = c === V.color ? 'on' : '';
    b.addEventListener('click', () => {
      V.color = c;
      [...cols.children].forEach((x) => x.classList.toggle('on', x === b));
    });
    cols.appendChild(b);
  }

  $('#vwClose').addEventListener('click', closeViewer);
  $('#vwUndo').addEventListener('click', () => { V.annotations.pop(); changed(); });
  $('#vwClear').addEventListener('click', () => {
    if (V.annotations.length && confirm('Remove all drawings and measurements on this image?')) { V.annotations.length = 0; changed(); }
  });
  $('#vwFit').addEventListener('click', () => { fit(); draw(); });
  $('#vwSave').addEventListener('click', saveImage);
  const lamp = $('#vwLamp');
  const on = (e) => { e.preventDefault(); V.lamp = true; draw(); };
  const off = () => { if (V) { V.lamp = false; draw(); } };
  lamp.addEventListener('pointerdown', on);
  lamp.addEventListener('pointerup', off);
  lamp.addEventListener('pointerleave', off);
  lamp.addEventListener('pointercancel', off);

  const cv = $('#vwCanvas');
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('wheel', onWheel, { passive: false });
  $('#vwNav').addEventListener('pointerdown', onNav);
  window.addEventListener('resize', onResize);
  setTool('pan');
}

function onResize() { if (V) draw(); }

function setTool(t) {
  V.tool = t;
  V.draft = null;
  document.querySelectorAll('#vwTools button').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  const hints = {
    pan: 'Drag to move · pinch or scroll to zoom',
    length: 'Drag across the area to measure (mm)',
    area: 'Drag from the centre outwards to measure an area',
    angle: 'Drag the first arm from the start point to the corner, then tap the end point',
    profile: 'Drag a line across the skin to see its colour & brightness profile',
    arrow: 'Drag to draw an arrow',
    text: 'Tap where the text should go',
    pen: 'Draw freely',
  };
  $('#vwHint').textContent = hints[t];
}

function changed() {
  draw();
  V.onChange?.(V.annotations);
}

// ------------------------------------------------------------ geometry
function stageSize() {
  const st = $('#vwStage');
  return { w: st.clientWidth, h: st.clientHeight };
}

function fit() {
  const { w, h } = stageSize();
  const z = Math.min(w / V.img.width, h / V.img.height) * 0.98;
  V.z = z;
  V.tx = (w - V.img.width * z) / 2;
  V.ty = (h - V.img.height * z) / 2;
}

// source px <-> render px <-> screen px
const s2r = (p) => ({ x: (p.x - V.crop.x) * V.s, y: (p.y - V.crop.y) * V.s });
const r2s = (p) => ({ x: p.x * V.z + V.tx, y: p.y * V.z + V.ty });
const s2s = (p) => r2s(s2r(p));
function screenToSource(e) {
  const r = $('#vwCanvas').getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const rx = (sx - V.tx) / V.z, ry = (sy - V.ty) / V.z;
  return { x: rx / V.s + V.crop.x, y: ry / V.s + V.crop.y, sx, sy };
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ------------------------------------------------------------ pointer handling
function onDown(e) {
  const cv = $('#vwCanvas');
  cv.setPointerCapture(e.pointerId);
  V.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (V.pointers.size === 2) {
    // pinch begins: cancel any drawing
    if (V.draft && V.draft.type !== 'angle2') V.draft = null;
    const [a, b] = [...V.pointers.values()];
    V.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, z: V.z, tx: V.tx, ty: V.ty };
    return;
  }
  const p = screenToSource(e);
  const t = V.tool;
  if (t === 'pan') V.drag = { x: e.clientX, y: e.clientY, tx: V.tx, ty: V.ty };
  else if (t === 'length' || t === 'arrow' || t === 'profile') V.draft = { type: t, a: p, b: p, color: V.color };
  else if (t === 'area') V.draft = { type: 'area', c: p, r: 0, color: V.color };
  else if (t === 'pen') V.draft = { type: 'pen', pts: [p], color: V.color };
  else if (t === 'angle') {
    if (V.draft && V.draft.type === 'angle2') {
      V.draft = { type: 'angle', a: V.draft.a, v: V.draft.v, b: p, color: V.draft.color };
      finish();
    } else V.draft = { type: 'angle1', a: p, v: p, color: V.color };
  } else if (t === 'text') {
    const text = prompt('Text to place on the image (e.g. "Botox", "IPL")');
    if (text) { V.annotations.push({ type: 'text', p, text, color: V.color }); changed(); }
  }
  draw();
}

function onMove(e) {
  if (!V.pointers.has(e.pointerId)) return;
  V.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (V.pointers.size === 2 && V.pinch) {
    const [a, b] = [...V.pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const r = $('#vwCanvas').getBoundingClientRect();
    const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
    const pc = { x: V.pinch.cx - r.left, y: V.pinch.cy - r.top };
    const z = Math.max(0.2, Math.min(12, V.pinch.z * (d / V.pinch.d)));
    // keep the point under the pinch centre fixed
    const rx = (pc.x - V.pinch.tx) / V.pinch.z, ry = (pc.y - V.pinch.ty) / V.pinch.z;
    V.z = z;
    V.tx = cx - rx * z;
    V.ty = cy - ry * z;
    draw();
    return;
  }
  const p = screenToSource(e);
  if (V.drag) {
    V.tx = V.drag.tx + (e.clientX - V.drag.x);
    V.ty = V.drag.ty + (e.clientY - V.drag.y);
  } else if (V.draft) {
    const d = V.draft;
    if (d.type === 'area') d.r = dist(d.c, p);
    else if (d.type === 'pen') d.pts.push(p);
    else if (d.type === 'angle1') d.v = p;
    else if (d.b) d.b = p;
  }
  draw();
}

function onUp(e) {
  V.pointers.delete(e.pointerId);
  if (V.pointers.size < 2) V.pinch = null;
  if (V.drag) { V.drag = null; return; }
  const d = V.draft;
  if (!d) return;
  if (d.type === 'angle1') {
    if (dist(d.a, d.v) * V.s * V.z > 8) V.draft = { type: 'angle2', a: d.a, v: d.v, color: d.color };
    else V.draft = null;
    draw();
    return;
  }
  if (d.type === 'angle2') return;
  finish();
}

function finish() {
  const d = V.draft;
  V.draft = null;
  const minLen = 6 / (V.s * V.z);
  if ((d.a && d.b && dist(d.a, d.b) < minLen) || (d.type === 'area' && d.r < minLen) || (d.type === 'pen' && d.pts.length < 2)) {
    draw();
    return;
  }
  if (d.type === 'area') d.brightness = areaBrightness(d.c, d.r);
  if (d.type === 'profile') { V.profile = d; showProfile(d); }
  V.annotations.push(d);
  changed();
}

function onWheel(e) {
  e.preventDefault();
  const r = $('#vwCanvas').getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const z = Math.max(0.2, Math.min(12, V.z * Math.exp(-e.deltaY * 0.0015)));
  const rx = (sx - V.tx) / V.z, ry = (sy - V.ty) / V.z;
  V.z = z; V.tx = sx - rx * z; V.ty = sy - ry * z;
  draw();
}

function onNav(e) {
  const nav = $('#vwNav');
  const r = nav.getBoundingClientRect();
  const k = V.img.width / r.width;
  const rx = (e.clientX - r.left) * k, ry = (e.clientY - r.top) * k;
  const { w, h } = stageSize();
  V.tx = w / 2 - rx * V.z;
  V.ty = h / 2 - ry * V.z;
  draw();
}

// ------------------------------------------------------------ measurements
function srcPixels(x0, y0, w, h) {
  const src = V.photo.source;
  const X = Math.max(0, Math.floor(x0)), Y = Math.max(0, Math.floor(y0));
  const W = Math.max(1, Math.min(src.width - X, Math.ceil(w))), H = Math.max(1, Math.min(src.height - Y, Math.ceil(h)));
  return { X, Y, W, H, d: src.getContext('2d', { willReadFrequently: true }).getImageData(X, Y, W, H).data };
}

function areaBrightness(c, r) {
  const { X, Y, W, H, d } = srcPixels(c.x - r, c.y - r, 2 * r + 1, 2 * r + 1);
  let s = 0, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ((X + x - c.x) ** 2 + (Y + y - c.y) ** 2 > r * r) continue;
      const i = (y * W + x) * 4;
      s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      n++;
    }
  }
  return n ? Math.round(s / n) : 0;
}

function angleDeg(a, v, b) {
  const a1 = Math.atan2(a.y - v.y, a.x - v.x), a2 = Math.atan2(b.y - v.y, b.x - v.x);
  let d = Math.abs(a1 - a2) * 180 / Math.PI;
  if (d > 180) d = 360 - d;
  return d;
}

function showProfile(d) {
  const n = 160;
  const x0 = Math.min(d.a.x, d.b.x) - 1, y0 = Math.min(d.a.y, d.b.y) - 1;
  const { X, Y, W, H, d: px } = srcPixels(x0, y0, Math.abs(d.b.x - d.a.x) + 3, Math.abs(d.b.y - d.a.y) + 3);
  const series = { R: [], G: [], B: [], Gray: [] };
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = Math.round(d.a.x + (d.b.x - d.a.x) * t) - X, y = Math.round(d.a.y + (d.b.y - d.a.y) * t) - Y;
    const j = (Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 4;
    series.R.push(px[j]); series.G.push(px[j + 1]); series.B.push(px[j + 2]);
    series.Gray.push(0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2]);
  }
  const mm = dist(d.a, d.b) / V.ppm;
  const W2 = 320, H2 = 150, pad = 26;
  const path = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${(pad + (i / (n - 1)) * (W2 - pad - 6)).toFixed(1)},${(H2 - pad - (v / 255) * (H2 - pad - 8)).toFixed(1)}`).join('');
  const gray = series.Gray;
  const mean = gray.reduce((a, b) => a + b, 0) / n;
  const rough = Math.sqrt(gray.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const el = $('#vwProfile');
  el.hidden = false;
  el.innerHTML = `<div class="vw-prof-head"><b>Line profile</b> · ${mm.toFixed(1)} mm · roughness ${rough.toFixed(1)}
    <button id="vwProfClose">✕</button></div>
    <svg viewBox="0 0 ${W2} ${H2}" width="${W2}" height="${H2}">
      <line x1="${pad}" y1="${H2 - pad}" x2="${W2 - 6}" y2="${H2 - pad}" stroke="#475569"/>
      <line x1="${pad}" y1="8" x2="${pad}" y2="${H2 - pad}" stroke="#475569"/>
      <text x="${pad - 4}" y="14" fill="#94a3b8" font-size="10" text-anchor="end">255</text>
      <text x="${pad - 4}" y="${H2 - pad}" fill="#94a3b8" font-size="10" text-anchor="end">0</text>
      <text x="${W2 - 6}" y="${H2 - 8}" fill="#94a3b8" font-size="10" text-anchor="end">${mm.toFixed(1)} mm</text>
      <path d="${path(series.R)}" stroke="#ef4444" fill="none" stroke-width="1.3"/>
      <path d="${path(series.G)}" stroke="#22c55e" fill="none" stroke-width="1.3"/>
      <path d="${path(series.B)}" stroke="#3b82f6" fill="none" stroke-width="1.3"/>
      <path d="${path(gray)}" stroke="#e2e8f0" fill="none" stroke-width="2"/>
    </svg>
    <div class="vw-prof-leg"><span style="color:#ef4444">R</span> <span style="color:#22c55e">G</span> <span style="color:#3b82f6">B</span> <span>Gray</span></div>`;
  $('#vwProfClose').addEventListener('click', () => (el.hidden = true));
}

// ------------------------------------------------------------ drawing
export function drawAnnotations(ctx, list, map, unit, ppm) {
  // map: source -> canvas coords, unit: line width in canvas px
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const label = (text, p, color) => {
    ctx.font = `600 ${unit * 7}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + unit * 6;
    const h = unit * 10;
    ctx.fillStyle = 'rgba(15,23,42,0.8)';
    ctx.fillRect(p.x + unit * 4, p.y - h - unit * 2, w, h);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, p.x + unit * 7, p.y - h / 2 - unit * 2);
  };
  for (const a of list) {
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.lineWidth = unit * 1.6;
    ctx.setLineDash([]);
    if (a.type === 'length' || a.type === 'profile' || a.type === 'arrow') {
      const p = map(a.a), q = map(a.b);
      if (a.type === 'profile') ctx.setLineDash([unit * 4, unit * 3]);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      ctx.setLineDash([]);
      if (a.type === 'arrow') {
        const ang = Math.atan2(q.y - p.y, q.x - p.x), L = unit * 9;
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(q.x - L * Math.cos(ang - 0.45), q.y - L * Math.sin(ang - 0.45));
        ctx.lineTo(q.x - L * Math.cos(ang + 0.45), q.y - L * Math.sin(ang + 0.45));
        ctx.closePath(); ctx.fill();
      } else {
        for (const e of [p, q]) {
          const ang = Math.atan2(q.y - p.y, q.x - p.x) + Math.PI / 2, L = unit * 4;
          ctx.beginPath();
          ctx.moveTo(e.x - L * Math.cos(ang), e.y - L * Math.sin(ang));
          ctx.lineTo(e.x + L * Math.cos(ang), e.y + L * Math.sin(ang));
          ctx.stroke();
        }
        const mm = dist(a.a, a.b) / ppm;
        label(`${mm.toFixed(1)} mm`, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, a.color);
      }
    } else if (a.type === 'area') {
      const c = map(a.c), e = map({ x: a.c.x + a.r, y: a.c.y });
      const R = Math.abs(e.x - c.x);
      ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, 7); ctx.stroke();
      const mm2 = Math.PI * (a.r / ppm) ** 2;
      label(`${mm2.toFixed(1)} mm²${a.brightness != null ? ` · bright ${a.brightness}` : ''}`, { x: c.x + R * 0.7, y: c.y - R * 0.7 }, a.color);
    } else if (a.type === 'angle' || a.type === 'angle1' || a.type === 'angle2') {
      const p = map(a.a), v = map(a.v);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(v.x, v.y);
      if (a.b) { const q = map(a.b); ctx.lineTo(q.x, q.y); }
      ctx.stroke();
      if (a.b) {
        const q = map(a.b);
        const a1 = Math.atan2(p.y - v.y, p.x - v.x), a2 = Math.atan2(q.y - v.y, q.x - v.x);
        ctx.beginPath();
        let d = a2 - a1;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        ctx.arc(v.x, v.y, unit * 14, a1, a1 + d, d < 0);
        ctx.stroke();
        label(`${angleDeg(a.a, a.v, a.b).toFixed(1)}°`, v, a.color);
      }
    } else if (a.type === 'text') {
      const p = map(a.p);
      ctx.font = `700 ${unit * 12}px system-ui, sans-serif`;
      ctx.lineWidth = unit * 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(a.text, p.x, p.y);
      ctx.fillText(a.text, p.x, p.y);
    } else if (a.type === 'pen') {
      ctx.beginPath();
      a.pts.forEach((pt, i) => { const p = map(pt); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
      ctx.stroke();
    }
  }
  ctx.restore();
}

function draw() {
  if (!V) return;
  const cv = $('#vwCanvas');
  const { w, h } = stageSize();
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#05080c';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  const img = V.lamp ? V.plain : V.img;
  ctx.drawImage(img, V.tx, V.ty, img.width * V.z, img.height * V.z);
  const list = V.draft ? [...V.annotations, V.draft] : V.annotations;
  drawAnnotations(ctx, list, s2s, 1.4, V.ppm);
  if (V.lamp) {
    ctx.fillStyle = 'rgba(15,23,42,0.75)';
    ctx.fillRect(12, 12, 120, 30);
    ctx.fillStyle = '#fde68a';
    ctx.font = '600 15px system-ui';
    ctx.fillText('Original', 24, 32);
  }
  drawNav();
}

function drawNav() {
  const nav = $('#vwNav');
  const W = 130, H = Math.round((W * V.img.height) / V.img.width);
  if (nav.width !== W * 2) { nav.width = W * 2; nav.height = H * 2; nav.style.width = `${W}px`; nav.style.height = `${H}px`; }
  const ctx = nav.getContext('2d');
  ctx.drawImage(V.img, 0, 0, nav.width, nav.height);
  const { w, h } = stageSize();
  const k = nav.width / V.img.width;
  const x = (-V.tx / V.z) * k, y = (-V.ty / V.z) * k, vw = (w / V.z) * k, vh = (h / V.z) * k;
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 4;
  ctx.strokeRect(x, y, vw, vh);
  nav.style.display = V.z > Math.min(w / V.img.width, h / V.img.height) * 1.05 ? 'block' : 'none';
}

async function saveImage() {
  const c = document.createElement('canvas');
  c.width = V.img.width;
  c.height = V.img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(V.img, 0, 0);
  drawAnnotations(ctx, V.annotations, s2r, Math.max(1.4, c.width / 600), V.ppm);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  const name = `${(V.fileBase || 'image').replace(/[^\w-]+/g, '_')}.jpg`;
  const file = new File([blob], name, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
