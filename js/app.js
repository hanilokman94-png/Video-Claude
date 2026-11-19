import { loadFaceModels, detectVideo, detectImage, faceBox } from './face.js';
import { analysePhoto, summarise, CATEGORIES } from './analysis.js';
import { buildCollage, drawPanel, SLOTS } from './collage.js';
import { renderImage, LIGHTS } from './views.js';
import { measureStructure } from './structure.js';
import { ZONE_LABEL, ZONE_LETTER, ZONE_ORDER } from './regions.js';
import { db, uid } from './db.js';
import { openViewer } from './viewer.js';
import { stateBar, zoneBars, lineChart } from './charts.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ------------------------------------------------------------------ constants
const CAPTURE_ORDER = ['front', 'left', 'right'];
const SLOT_NAME = { front: 'Front', left: 'Left 45°', right: 'Right 45°' };
const TARGET = {
  front: { yaw: 0, tol: 7, text: 'Front: face looking straight at the camera' },
  left: { yaw: -45, tol: 12, text: 'Left side: ask the patient to turn their head to THEIR RIGHT' },
  right: { yaw: 45, tol: 12, text: 'Right side: ask the patient to turn their head to THEIR LEFT' },
};
const MAX_SIDE = 3264;
const ALL_MODES = [
  ['N', '', 'Normal'], ['P', '', 'Polarized-style'], ['U', '', 'UV-style'],
  ['N', 'PW', 'Pores & wrinkles'], ['P', 'F', 'Surface spots'], ['U', 'F', 'Deep pigment'], ['U', 'S', 'Sebum'],
  ['N', 'RED', 'Redness'], ['N', 'TEX', 'Texture & scars'], ['N', 'ZONES', 'Zones'], ['N', 'STRUCT', 'Structure'],
];
const CAT_VIEW = {
  pores: ['N', 'PW'], wrinkles: ['N', 'PW'], spots: ['P', 'F'], deep: ['U', 'F'], sebum: ['U', 'S'],
  redness: ['N', 'RED'], texture: ['N', 'TEX'], tone: ['N', 'ZONES'], structure: ['N', 'STRUCT'],
};
const CAT_COLORS = { pores: '#0ea5e9', wrinkles: '#eab308', spots: '#f97316', deep: '#d946ef', sebum: '#14b8a6', redness: '#ef4444', texture: '#64748b' };

const EXPLAIN = {
  pores: {
    what: 'Visible pore openings per cm², counted on the nose, cheeks, forehead and chin (cyan dots on N+P.W).',
    why: 'Pores enlarge mainly with sebum production from the mid-20s, and look larger again as skin loses elasticity from the 30s.',
    care: 'Oil control and regular exfoliation (BHA), retinoids, and pore-tightening procedures such as fractional laser, RF microneedling or chemical peels.',
  },
  wrinkles: {
    what: 'Length of fine linear lines (mm per cm²): forehead, around the eyes and cheeks (yellow on N+P.W).',
    why: 'The skin around the eyes is thin and loses moisture quickly, so lines show there first. Expression, sun and collagen loss deepen them.',
    care: 'Hydration in the 20s and anti-ageing care from the 30s: sunscreen, retinoids, peptides, plus botulinum toxin, fillers, skin boosters or energy devices as indicated.',
  },
  spots: {
    what: 'Defined brown spots in the upper skin (orange on P+F): freckles, sun spots, post-acne marks.',
    why: 'UV exposure, hormones and inflammation increase melanin in the epidermis.',
    care: 'Epidermal spots usually respond well to exfoliation, brightening actives, peels and pigment lasers / IPL, with strict daily sunscreen.',
  },
  deep: {
    what: 'Broad, soft-edged pigment (magenta on U+F), the kind of pattern seen in melasma or deeper pigment.',
    why: 'Deeper or diffuse pigment is driven by hormones, heat, visible light and UV, and tends to come back.',
    care: 'Needs continuous, gentle care and maintenance: tyrosinase inhibitors, tranexamic acid, low-fluence laser toning, strict sun & visible-light protection. Confirm with Wood’s lamp or dermoscopy.',
  },
  sebum: {
    what: 'Shiny (oily) skin surface by zone (white-cyan on U+S). This depends on when the face was last washed.',
    why: 'Sebum output is highest on the T-zone (forehead & nose). The location and amount define the skin type.',
    care: 'Oil-control cleansing, niacinamide, light non-comedogenic moisturisers, and for acne-prone skin, treatments that reduce sebum and acne bacteria.',
  },
  redness: {
    what: 'Areas of increased redness (haemoglobin) and small red spots that may be active blemishes (circled).',
    why: 'Inflammation, acne, sensitivity, rosacea or visible blood vessels.',
    care: 'Barrier repair, anti-inflammatory care, acne treatment where needed; vascular laser / IPL for persistent redness or vessels.',
  },
  texture: {
    what: 'Skin surface roughness and shallow depressions such as acne scars (orange circles on the relief map).',
    why: 'Past inflammatory acne, enlarged pores and photo-ageing make the surface uneven.',
    care: 'Resurfacing: fractional laser, RF microneedling, subcision or peels, usually as a course of sessions.',
  },
};

// ------------------------------------------------------------------ state
const S = {
  facing: 'environment',
  guide: 'none',
  ghostAlpha: 0.5,
  customers: [],
  customer: null,
  sex: null,
  visit: null, // stored record (without runtime photos)
  photos: {}, // runtime photos of the current visit
  slot: 'front',
  stream: null,
  running: false,
  okFrames: 0,
  lastNose: null,
  ghost: {},
  pos: 'front',
  slotMode: { N: '', P: '', U: '' },
  allMode: 0,
  cat: 'pores',
  anPos: 'front',
  anZones: false,
  lamp: false,
  histCat: 'all',
  refs: null,
  cmp: { a: null, b: null, pos: 'front', mode: 0 },
  runtime: new Map(), // visitId -> { photos }
  screen: 'customer',
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), ms);
}

function age(birthday, at = Date.now()) {
  if (!birthday) return null;
  const b = new Date(birthday), d = new Date(at);
  let a = d.getFullYear() - b.getFullYear();
  if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) a--;
  return a;
}
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const shortDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });

// ------------------------------------------------------------------ navigation
function hasPhotos() { return Object.keys(S.photos).length > 0; }
function analysed() { return !!S.visit?.summary; }

function updateFlow() {
  const enabled = {
    customer: true,
    capture: !!S.customer,
    images: hasPhotos(),
    analysis: analysed(),
    total: analysed(),
    history: !!S.customer,
    compare: !!S.customer,
  };
  $$('#flow button').forEach((b) => {
    b.disabled = !enabled[b.dataset.go];
    b.classList.toggle('on', b.dataset.go === S.screen);
  });
  const c = S.customer;
  $('#who').innerHTML = c
    ? `<b>${esc(c.name)}</b> · ${c.sex === 'F' ? 'F' : 'M'} · ${age(c.birthday) ?? '?'} y${S.visit ? ` · ${shortDate(S.visit.date)}` : ''}`
    : '';
}

async function go(screen) {
  if (screen !== 'capture') stopCamera();
  S.screen = screen;
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === screen));
  document.body.classList.toggle('capturing', screen === 'capture');
  updateFlow();
  window.scrollTo(0, 0);
  if (screen === 'customer') renderCustomer();
  if (screen === 'capture') startCapture();
  if (screen === 'images') renderImages();
  if (screen === 'analysis') { await ensureRefs(); renderAnalysis(); }
  if (screen === 'total') { await ensureRefs(); renderTotal(); }
  if (screen === 'history') renderHistory();
  if (screen === 'compare') renderCompare();
}

// ------------------------------------------------------------------ customers
async function refreshCustomers() {
  S.customers = await db.customers();
  renderCustomerList();
}

function renderCustomerList() {
  const q = $('#custSearch').value.trim().toLowerCase();
  const list = S.customers.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.phone || '').includes(q));
  $('#custList').innerHTML = list.length
    ? list.map((c) => `<div class="item ${S.customer?.id === c.id ? 'on' : ''}" data-id="${c.id}">
        <div><div class="n">${esc(c.name)}</div><div class="m">${c.sex === 'F' ? 'Female' : 'Male'} · ${age(c.birthday) ?? '?'} y</div></div>
        <div class="m">${c.lastVisit ? shortDate(c.lastVisit) : 'new'}</div></div>`).join('')
    : `<div class="empty">${S.customers.length ? 'No match.' : 'No customers yet. Fill in the form to add the first one.'}</div>`;
  $$('#custList .item').forEach((el) => el.addEventListener('click', () => selectCustomer(el.dataset.id)));
}

function fillForm(c) {
  const f = $('#custForm');
  for (const k of ['name', 'birthday', 'adviser', 'phone', 'email', 'notes']) f.elements[k].value = c?.[k] || '';
  setSex(c?.sex || null);
  $('#formTitle').textContent = c ? 'Customer information' : 'New customer';
  $('#delCust').disabled = !c;
}

function setSex(v) {
  S.sex = v;
  $$('#sexSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
}

function readForm() {
  const f = $('#custForm');
  const data = {};
  for (const k of ['name', 'birthday', 'adviser', 'phone', 'email', 'notes']) data[k] = f.elements[k].value.trim();
  data.sex = S.sex;
  return data;
}

async function saveCustomer(silent) {
  const d = readForm();
  if (!d.name || !d.sex || !d.birthday) {
    toast('Name, sex and birthday are required (needed for comparisons).');
    return null;
  }
  const c = { ...(S.customer || { id: uid(), created: Date.now() }), ...d };
  await db.saveCustomer(c);
  S.customer = c;
  await refreshCustomers();
  fillForm(c);
  renderVisits();
  updateFlow();
  if (!silent) toast('Saved ✓');
  return c;
}

async function selectCustomer(id) {
  if (S.customer?.id !== id) resetVisit();
  S.customer = await db.customer(id);
  fillForm(S.customer);
  renderCustomerList();
  renderVisits();
  updateFlow();
}

function resetVisit() {
  S.visit = null;
  S.photos = {};
  S.refs = null;
  S.ghost = {};
  S.runtime.clear();
}

async function renderVisits() {
  const panel = $('#visitPanel');
  if (!S.customer) { panel.hidden = true; return; }
  const visits = await db.visits(S.customer.id);
  panel.hidden = !visits.length;
  const box = $('#visitList');
  box.querySelectorAll('img').forEach((i) => URL.revokeObjectURL(i.src));
  box.innerHTML = [...visits].reverse().map((v) => {
    const blob = v.photos?.front || Object.values(v.photos || {})[0];
    const url = blob ? URL.createObjectURL(blob) : '';
    const c = v.summary?.cats;
    return `<div class="visit-card" data-id="${v.id}">${url ? `<img src="${url}" alt="">` : ''}
      <div><div class="d">${fmtDate(v.date)}</div>
      <div class="muted">${c ? `Pores ${c.pores.score} · Spots ${c.spots.score} · Wrinkles ${c.wrinkles.score}` : 'not analysed'}</div></div></div>`;
  }).join('');
  $$('#visitList .visit-card').forEach((el) => el.addEventListener('click', () => openVisit(el.dataset.id)));
}

function renderCustomer() {
  renderCustomerList();
  renderVisits();
  db.estimate().then((e) => {
    if (e?.usage != null) $('#storageInfo').textContent = `Stored on this device: ${(e.usage / 1e6).toFixed(0)} MB`;
  });
}

async function startVisit() {
  const c = await saveCustomer(true);
  if (!c) return;
  resetVisit();
  S.visit = { id: uid(), customerId: c.id, date: Date.now(), adviser: c.adviser || '', photos: {}, annotations: {}, answers: {}, advice: '', recommend: '' };
  db.persist();
  go('capture');
}

function initCustomer() {
  $('#custSearch').addEventListener('input', renderCustomerList);
  $('#newCust').addEventListener('click', () => { S.customer = null; resetVisit(); fillForm(null); renderCustomerList(); renderVisits(); updateFlow(); $('#custForm').elements.name.focus(); });
  $('#clearCust').addEventListener('click', () => { const id = S.customer; fillForm(null); S.customer = id ? S.customer : null; if (S.customer) { $('#formTitle').textContent = 'Customer information'; $('#delCust').disabled = false; } });
  $('#saveCust').addEventListener('click', () => saveCustomer());
  $('#delCust').addEventListener('click', async () => {
    if (!S.customer) return;
    if (!confirm(`Delete ${S.customer.name} and ALL their visits and photos? This cannot be undone.`)) return;
    await db.deleteCustomer(S.customer.id);
    S.customer = null;
    resetVisit();
    fillForm(null);
    await refreshCustomers();
    renderVisits();
    updateFlow();
    toast('Deleted');
  });
  $('#custForm').addEventListener('submit', (e) => { e.preventDefault(); saveCustomer(); });
  $$('#sexSeg button').forEach((b) => b.addEventListener('click', () => setSex(b.dataset.v)));
  $('#startVisit').addEventListener('click', startVisit);
  $('#clinicName').value = store.get('clinicName') || '';
  $('#clinicName').addEventListener('input', (e) => store.set('clinicName', e.target.value));
  S.facing = store.get('facing') || 'environment';
  const setFacing = (f) => { S.facing = f; store.set('facing', f); $$('#cameraSeg button').forEach((b) => b.classList.toggle('on', b.dataset.facing === f)); };
  setFacing(S.facing);
  $$('#cameraSeg button').forEach((b) => b.addEventListener('click', () => setFacing(b.dataset.facing)));
  S.setFacing = setFacing;
  fillForm(null);
}

// ------------------------------------------------------------------ visits: load / save
async function photoFromBlob(slot, blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  const face = detectImage(c);
  if (!face) return null;
  return { slot, source: c, face, blob, result: null };
}

async function loadVisitRuntime(visit, slots = CAPTURE_ORDER) {
  let rt = S.runtime.get(visit.id);
  if (!rt) {
    rt = { photos: {} };
    S.runtime.set(visit.id, rt);
    // keep memory small: at most current + 2 other visits
    const keys = [...S.runtime.keys()].filter((k) => k !== visit.id && k !== S.visit?.id);
    while (keys.length > 2) S.runtime.delete(keys.shift());
  }
  for (const slot of slots) {
    if (rt.photos[slot] || !visit.photos?.[slot]) continue;
    const p = await photoFromBlob(slot, visit.photos[slot]);
    if (p) rt.photos[slot] = p;
  }
  return rt;
}

function ensureResult(p) {
  if (p && !p.result) p.result = analysePhoto(p.source, p.face);
  return p;
}

async function openVisit(id) {
  await loadFaceModels().catch(() => {});
  const v = await db.visit(id);
  if (!v) return;
  resetVisit();
  S.visit = v;
  v.annotations ??= {};
  v.answers ??= {};
  setProgress(true, 'Loading photos…');
  await go('images');
  const rt = await loadVisitRuntime(v);
  S.photos = rt.photos;
  await analyseCurrent();
}

function canvasToBlob(c) {
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
}

let saveTimer = null;
function saveVisitSoon() {
  clearTimeout(saveTimer);
  $('#savedState').textContent = 'Saving…';
  saveTimer = setTimeout(saveVisit, 700);
}

async function saveVisit() {
  if (!S.visit || !S.customer) return;
  for (const [slot, p] of Object.entries(S.photos)) {
    if (!p.blob) p.blob = await canvasToBlob(p.source);
    S.visit.photos[slot] = p.blob;
  }
  await db.saveVisit(S.visit);
  if (!S.customer.lastVisit || S.customer.lastVisit < S.visit.date) {
    S.customer.lastVisit = S.visit.date;
    await db.saveCustomer(S.customer);
  }
  S.runtime.set(S.visit.id, { photos: S.photos });
  const el = $('#savedState');
  if (el) el.textContent = `Saved ✓ ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// ------------------------------------------------------------------ capture
const detCanvas = document.createElement('canvas');
const detCtx = detCanvas.getContext('2d', { willReadFrequently: true });

async function startCapture() {
  if (!S.visit) {
    if (!S.customer) { go('customer'); return; }
    S.visit = { id: uid(), customerId: S.customer.id, date: Date.now(), adviser: S.customer.adviser || '', photos: {}, annotations: {}, answers: {}, advice: '', recommend: '' };
  }
  S.slot = CAPTURE_ORDER.find((s) => !S.photos[s]) || 'front';
  updateSteps();
  setGuide(S.guide);
  loadGhosts();
  try { await loadFaceModels(); } catch { toast('Face AI could not load: check the internet connection.'); }
  await openCamera();
}

async function loadGhosts() {
  S.ghost = {};
  if (!S.customer) return;
  const prev = (await db.visits(S.customer.id)).filter((v) => v.id !== S.visit?.id && v.date < (S.visit?.date || Infinity));
  const last = prev[prev.length - 1];
  if (!last) return;
  for (const slot of CAPTURE_ORDER) {
    if (last.photos?.[slot]) {
      try { S.ghost[slot] = await createImageBitmap(last.photos[slot]); } catch { /* ignore */ }
    }
  }
}

async function openCamera() {
  stopCamera();
  const video = $('#video');
  $('#camWrap').classList.toggle('mirror', S.facing === 'user');
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: S.facing }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
  } catch (e) {
    console.error(e);
    toast('Camera not available. Allow camera access (the page must be opened over https). You can still use Import.', 5000);
    return;
  }
  video.srcObject = S.stream;
  await video.play().catch(() => {});
  await new Promise((r) => (video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
  S.running = true;
  S.okFrames = 0;
  loop();
}

function stopCamera() {
  S.running = false;
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
}

function loop() {
  if (!S.running) return;
  const video = $('#video');
  const vw = video.videoWidth, vh = video.videoHeight;
  if (vw && vh && video.readyState >= 2) {
    const dw = 640, dh = Math.round((640 * vh) / vw);
    if (detCanvas.width !== dw) { detCanvas.width = dw; detCanvas.height = dh; }
    detCtx.drawImage(video, 0, 0, dw, dh);
    let face = null;
    try { face = detectVideo(detCanvas, performance.now()); } catch (e) { console.warn(e); }
    evaluate(face, dw, dh);
  }
  requestAnimationFrame(loop);
}

function brightness(face) {
  const b = faceBox(face.pts, -0.15);
  const x = Math.max(0, b.x | 0), y = Math.max(0, b.y | 0);
  const w = Math.max(1, Math.min(detCanvas.width - x, b.w | 0)), h = Math.max(1, Math.min(detCanvas.height - y, b.h | 0));
  const d = detCtx.getImageData(x, y, w, h).data;
  let left = 0, right = 0, nl = 0, nr = 0;
  for (let yy = 0; yy < h; yy += 3) {
    for (let xx = 0; xx < w; xx += 3) {
      const i = (yy * w + xx) * 4;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (xx < w / 2) { left += l; nl++; } else { right += l; nr++; }
    }
  }
  left /= nl || 1; right /= nr || 1;
  return { mean: (left + right) / 2, ratio: Math.min(left, right) / Math.max(left, right, 1) };
}

const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

function drawGuides(ctx, W, H) {
  if (S.guide === 'ghost' && S.ghost[S.slot]) {
    const g = S.ghost[S.slot];
    const k = Math.max(W / g.width, H / g.height);
    ctx.globalAlpha = S.ghostAlpha;
    ctx.drawImage(g, (W - g.width * k) / 2, (H - g.height * k) / 2, g.width * k, g.height * k);
    ctx.globalAlpha = 1;
  }
  if (S.guide === '4' || S.guide === '48') {
    const cols = S.guide === '4' ? 2 : 8, rows = S.guide === '4' ? 2 : 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(1, W / 900);
    ctx.beginPath();
    for (let i = 1; i < cols; i++) { ctx.moveTo((W * i) / cols, 0); ctx.lineTo((W * i) / cols, H); }
    for (let j = 1; j < rows; j++) { ctx.moveTo(0, (H * j) / rows); ctx.lineTo(W, (H * j) / rows); }
    ctx.stroke();
  }
}

function evaluate(face, dw, dh) {
  const ov = $('#overlay');
  const video = $('#video');
  if (ov.width !== video.videoWidth) { ov.width = video.videoWidth; ov.height = video.videoHeight; }
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, ov.width, ov.height);
  drawGuides(ctx, ov.width, ov.height);
  const k = ov.width / dw;
  const t = TARGET[S.slot];
  const checks = { face: false, angle: false, dist: false, level: false, light: false };
  let hint = '';

  if (!face) {
    hint = 'No face found: point the camera at the patient';
    setGauge(null);
  } else {
    checks.face = true;
    const { yaw, pitch, roll } = face.pose;
    setGauge(yaw);
    const faceH = Math.hypot(face.pts[10].x - face.pts[152].x, face.pts[10].y - face.pts[152].y) / dh;
    const cx = face.pts[1].x / dw, cy = face.pts[1].y / dh;
    const L = brightness(face);
    checks.angle = Math.abs(yaw - t.yaw) <= t.tol;
    checks.dist = faceH >= 0.36 && faceH <= 0.78 && cx > 0.2 && cx < 0.8 && cy > 0.2 && cy < 0.8;
    checks.level = Math.abs(roll) < 8 && Math.abs(pitch) < 14;
    checks.light = L.mean > 75 && L.mean < 215 && (S.slot !== 'front' || L.ratio > 0.72);

    if (!checks.dist) {
      if (faceH < 0.36) hint = 'Move closer: the face should fill most of the screen';
      else if (faceH > 0.78) hint = 'Move back a little';
      else hint = 'Centre the face on screen';
    } else if (!checks.angle) {
      if (S.slot === 'front') hint = yaw - t.yaw > 0 ? 'Turn head slightly to THEIR RIGHT' : 'Turn head slightly to THEIR LEFT';
      else if (Math.sign(yaw) !== Math.sign(t.yaw) || Math.abs(yaw) < Math.abs(t.yaw) - t.tol) {
        hint = `Turn head further to ${S.slot === 'right' ? 'THEIR LEFT' : 'THEIR RIGHT'}`;
      } else hint = 'Turn back a little (too far)';
    } else if (!checks.level) {
      hint = Math.abs(roll) >= 8 ? "Keep the head straight (don't tilt to the shoulder)" : 'Keep the chin level';
    } else if (!checks.light) {
      hint = L.mean <= 75 ? 'Too dark: add light in front of the face' : L.mean >= 215 ? 'Too bright: reduce light / avoid flash' : 'Light is uneven: face the light source';
    }

    const allOk = Object.values(checks).every(Boolean);
    ctx.save();
    ctx.lineWidth = Math.max(2, ov.width / 500);
    ctx.strokeStyle = allOk ? 'rgba(34,197,94,0.95)' : 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    OVAL.forEach((i, n) => { const p = face.pts[i]; n ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k); });
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    const nose = face.pts[1];
    const moved = S.lastNose ? Math.hypot(nose.x - S.lastNose.x, nose.y - S.lastNose.y) / dw : 1;
    S.lastNose = nose;
    if (allOk && moved < 0.006) S.okFrames++;
    else S.okFrames = 0;
  }

  $('#instruction').textContent = t.text;
  $('#hint').textContent = hint || (checks.face ? 'Hold still…' : '');
  $$('#checks span').forEach((s) => { const v = checks[s.dataset.k]; s.classList.toggle('ok', v); s.classList.toggle('no', !v); });
  $('#shutter').classList.toggle('ready', S.okFrames > 0);
  if ($('#autoCap').checked && S.okFrames >= 14 && !capture.busy) {
    S.okFrames = 0;
    capture();
  }
}

function setGauge(yaw) {
  const range = 70;
  const pos = (v) => `${((Math.max(-range, Math.min(range, v)) + range) / (2 * range)) * 100}%`;
  const t = TARGET[S.slot];
  $('#gaugeZone').style.left = pos(t.yaw - t.tol);
  $('#gaugeZone').style.width = `${((2 * t.tol) / (2 * range)) * 100}%`;
  $('#gaugeNeedle').style.left = yaw == null ? '50%' : pos(yaw);
  $('#gaugeNeedle').style.opacity = yaw == null ? 0.3 : 1;
  $('#yawText').textContent = yaw == null ? 'n/a' : `${Math.abs(yaw).toFixed(0)}°`;
}

async function capture() {
  if (capture.busy) return;
  capture.busy = true;
  try {
    const video = $('#video');
    if (!video.videoWidth) { toast('Camera not ready'); return; }
    $('#flash').classList.add('on');
    setTimeout(() => $('#flash').classList.remove('on'), 60);
    const c = document.createElement('canvas');
    const s = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    c.width = Math.round(video.videoWidth * s);
    c.height = Math.round(video.videoHeight * s);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    const face = detectImage(c);
    if (!face) { toast('No face in the photo, try again'); return; }
    setPhoto(S.slot, c, face);
    const off = Math.abs(face.pose.yaw - TARGET[S.slot].yaw) > TARGET[S.slot].tol + 5;
    toast(off ? `${SLOT_NAME[S.slot]} saved, but the angle is ${Math.abs(face.pose.yaw).toFixed(0)}°. Retake if needed.` : `${SLOT_NAME[S.slot]} ✓`);
    const next = CAPTURE_ORDER.find((x) => !S.photos[x]);
    if (next) S.slot = next;
    updateSteps();
    if (!next) {
      await new Promise((r) => setTimeout(r, 500));
      toImages();
    }
  } finally {
    setTimeout(() => (capture.busy = false), 900);
  }
}

function setPhoto(slot, canvas, face) {
  S.photos[slot] = { slot, source: canvas, face, result: null, blob: null };
  if (S.visit) {
    S.visit.summary = null;
    if (S.visit.annotations) S.visit.annotations[slot] = [];
  }
}

function updateSteps() {
  $$('#steps .step').forEach((b) => {
    const slot = b.dataset.slot;
    b.classList.toggle('current', slot === S.slot);
    b.classList.toggle('done', !!S.photos[slot]);
    const cv = b.querySelector('canvas');
    cv.width = 108; cv.height = 144;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (S.photos[slot]) drawPanel(ctx, S.photos[slot], 'N', '', 0, 0, cv.width, cv.height);
  });
  $('#toImages').disabled = !hasPhotos();
  $('#ghostAlphaWrap').hidden = S.guide !== 'ghost';
}

function setGuide(g) {
  if (g === 'ghost' && !Object.keys(S.ghost).length) toast('Ghost overlay uses the photos from the previous visit (none found yet).');
  S.guide = g;
  $$('#guideSeg button').forEach((b) => b.classList.toggle('on', b.dataset.g === g));
  $('#ghostAlphaWrap').hidden = g !== 'ghost';
}

async function importFiles(files) {
  if (!files.length) return;
  try { await loadFaceModels(); } catch { toast('Face AI not loaded'); return; }
  toast('Reading photos…');
  const found = [];
  for (const f of files.slice(0, 6)) {
    try {
      const bmp = await createImageBitmap(f);
      const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * s);
      c.height = Math.round(bmp.height * s);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close?.();
      const face = detectImage(c);
      if (face) found.push({ c, face });
      else toast(`No face found in ${f.name}`);
    } catch (e) {
      console.error(e);
      toast(`Could not read ${f.name}`);
    }
  }
  $('#importFiles').value = '';
  if (!found.length) return;
  if (found.length === 1) {
    setPhoto(S.slot, found[0].c, found[0].face);
  } else {
    const fi = found.reduce((bi, p, i) => (Math.abs(p.face.pose.yaw) < Math.abs(found[bi].face.pose.yaw) ? i : bi), 0);
    setPhoto('front', found[fi].c, found[fi].face);
    const rest = found.filter((_, i) => i !== fi).sort((a, b) => a.face.pose.yaw - b.face.pose.yaw);
    const neg = rest.filter((p) => p.face.pose.yaw <= 0), pos = rest.filter((p) => p.face.pose.yaw > 0);
    if (neg.length) setPhoto('left', neg[0].c, neg[0].face);
    if (pos.length) setPhoto('right', pos[pos.length - 1].c, pos[pos.length - 1].face);
  }
  const next = CAPTURE_ORDER.find((x) => !S.photos[x]);
  if (next) S.slot = next;
  updateSteps();
  if (!next || found.length > 1) toImages();
}

function initCapture() {
  $('#shutter').addEventListener('click', capture);
  $('#camCancel').addEventListener('click', () => go(hasPhotos() ? 'images' : 'customer'));
  $('#camSwitch').addEventListener('click', () => { S.setFacing(S.facing === 'user' ? 'environment' : 'user'); openCamera(); });
  $('#toImages').addEventListener('click', toImages);
  $('#importFiles').addEventListener('change', (e) => importFiles([...e.target.files]));
  $$('#steps .step').forEach((b) => b.addEventListener('click', () => { S.slot = b.dataset.slot; S.okFrames = 0; updateSteps(); }));
  $$('#guideSeg button').forEach((b) => b.addEventListener('click', () => setGuide(b.dataset.g)));
  $('#ghostAlpha').addEventListener('input', (e) => { S.ghostAlpha = e.target.value / 100; $('#ghostAlphaVal').textContent = `${e.target.value}%`; });
}

// ------------------------------------------------------------------ analysis pipeline
function setProgress(on, text) {
  $('#progress').classList.toggle('on', on);
  if (text) $('#progressText').textContent = text;
}

async function toImages() {
  stopCamera();
  S.pos = S.photos.front ? 'front' : Object.keys(S.photos)[0];
  await go('images');
  await analyseCurrent();
}

async function analyseCurrent() {
  for (const slot of CAPTURE_ORDER) {
    const p = S.photos[slot];
    if (!p || p.result) continue;
    setProgress(true, `Analysing ${SLOT_NAME[slot].toLowerCase()} photo…`);
    await tick();
    try { ensureResult(p); } catch (e) { console.error(e); toast(`Analysis failed for ${SLOT_NAME[slot]}: ${e.message}`); }
  }
  const res = {};
  for (const s of CAPTURE_ORDER) if (S.photos[s]?.result) res[s] = S.photos[s].result;
  if (!S.visit.summary) {
    S.visit.summary = summarise(res);
    S.visit.structure = S.photos.front ? strip(measureStructure(S.photos.front.face)) : null;
    S.visit.poses = Object.fromEntries(Object.entries(S.photos).map(([k, p]) => [k, Math.round(p.face.pose.yaw)]));
    S.refs = null;
  }
  setProgress(true, 'Saving…');
  await saveVisit();
  setProgress(false);
  updateFlow();
  if (S.screen === 'images') renderImages();
}

function strip(st) {
  const { midline, ...rest } = st;
  return JSON.parse(JSON.stringify(rest));
}

// ------------------------------------------------------------------ 3. images
function renderImages() {
  $$('#posSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.pos === S.pos);
    b.disabled = b.dataset.pos !== 'all' && !S.photos[b.dataset.pos];
  });
  const all = S.pos === 'all';
  $('#slotsView').hidden = all;
  $('#allView').hidden = !all;
  if (all) renderAll(); else renderSlots();
}

function slotFoot(L, p) {
  const r = p?.result;
  if (!r) return 'Analysing…';
  const Z = Object.values(r.zones);
  const sum = (k) => Z.reduce((s, z) => s + z[k], 0);
  if (L === 'N') return `Pores ${r.pores.length} · wrinkle lines ${r.wrinkles.length}`;
  if (L === 'P') return `Surface spots ${r.spots.length}`;
  return `Diffuse pigment patches ${r.patches.length} · shine ${(sum('shinePct') / Math.max(1, Z.length)).toFixed(1)}%`;
}

function renderSlots() {
  const p = S.photos[S.pos];
  const box = $('#slotsView');
  box.innerHTML = '';
  for (const [L, def] of Object.entries(LIGHTS)) {
    const mode = S.slotMode[L];
    const el = document.createElement('div');
    el.className = 'slot';
    const btns = [['', L], ...def.fns.map((f) => [f.id, f.label]), ['B', 'B']];
    el.innerHTML = `<div class="slot-head"><div class="t">${def.label}<small>${def.sub}</small></div>
      <div class="slot-btns">${btns.map(([m, lab]) => `<button data-m="${m}" class="${mode === m ? 'on' : ''}">${lab}</button>`).join('')}</div></div>
      <canvas></canvas><div class="slot-foot">${slotFoot(L, p)}</div>`;
    box.appendChild(el);
    const cv = el.querySelector('canvas');
    if (p) {
      const img = S.lamp ? renderImage(p, 'N', '', 1100) : renderImage(p, L, p.result ? mode : '', 1100);
      cv.width = img.width; cv.height = img.height;
      cv.getContext('2d').drawImage(img, 0, 0);
    }
    el.querySelectorAll('.slot-btns button').forEach((b) => b.addEventListener('click', () => {
      // like a light-box: pressing the active function again cycles M -> B -> plain
      const m = b.dataset.m;
      const cur = S.slotMode[L];
      S.slotMode[L] = m && cur === m && m !== 'B' ? 'B' : m === 'B' && cur === 'B' ? '' : m;
      renderSlots();
    }));
    cv.addEventListener('click', () => p && openPhotoViewer(p, L, S.slotMode[L]));
  }
}

function openPhotoViewer(p, light, mode, visit = S.visit) {
  if (!p.result) { toast('Still analysing…'); return; }
  visit.annotations ??= {};
  visit.annotations[p.slot] ??= [];
  openViewer({
    photo: p, light, mode,
    title: `${SLOT_NAME[p.slot]} · ${fmtDate(visit.date)}`,
    fileBase: `${S.customer?.name || 'patient'}_${SLOT_NAME[p.slot]}_${new Date(visit.date).toISOString().slice(0, 10)}`,
    annotations: visit.annotations[p.slot],
    onChange: () => { if (visit === S.visit) saveVisitSoon(); else db.saveVisit(visit); },
  });
}

let collageCanvas = null;
function renderAll() {
  const chips = $('#allModes');
  chips.innerHTML = ALL_MODES.map(([, , lab], i) => `<button data-i="${i}" class="${i === S.allMode ? 'on' : ''}">${lab}</button>`).join('');
  chips.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { S.allMode = +b.dataset.i; renderAll(); }));
  const [L, M, label] = ALL_MODES[S.allMode];
  const ready = Object.values(S.photos).every((p) => p.result);
  collageCanvas = buildCollage(S.photos, L, ready || !M ? M : '', collageInfo(), label);
  const c = $('#collage');
  c.width = collageCanvas.width; c.height = collageCanvas.height;
  c.getContext('2d').drawImage(collageCanvas, 0, 0);
}

function collageInfo() {
  const c = S.customer;
  return {
    clinic: $('#clinicName').value.trim(),
    patient: c ? `${c.name} (${c.sex}, ${age(c.birthday, S.visit?.date) ?? '?'} y)` : '',
    date: S.visit ? fmtDate(S.visit.date) : '',
  };
}

async function shareCanvas(canvas, name) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
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

function initImages() {
  $$('#posSeg button').forEach((b) => b.addEventListener('click', () => { S.pos = b.dataset.pos; renderImages(); }));
  $('#retake').addEventListener('click', () => go('capture'));
  const lamp = $('#lampAll');
  const on = (e) => { e.preventDefault(); S.lamp = true; renderImages(); };
  const off = () => { if (S.lamp) { S.lamp = false; renderImages(); } };
  lamp.addEventListener('pointerdown', on);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => lamp.addEventListener(ev, off));
  $('#saveCollage').addEventListener('click', () => {
    const [, , label] = ALL_MODES[S.allMode];
    shareCanvas(collageCanvas, `${(S.customer?.name || 'patient').replace(/[^\w-]+/g, '_')}_${label.replace(/\W+/g, '-')}.jpg`);
  });
  $('#collage').addEventListener('click', (e) => {
    const c = $('#collage');
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * c.width;
    const n = Math.max(0, Math.min(2, Math.floor((x - 24) / ((c.width - 48) / 3))));
    const p = S.photos[SLOTS[n].id];
    const [L, M] = ALL_MODES[S.allMode];
    if (p) openPhotoViewer(p, L, M === 'STRUCT' ? '' : M);
  });
}

// ------------------------------------------------------------------ reference (clinic averages)
async function ensureRefs() {
  if (S.refs || !S.customer || !S.visit) return;
  const [visits, customers] = await Promise.all([db.allVisitSummaries(), db.customers()]);
  const cmap = new Map(customers.map((c) => [c.id, c]));
  const myAge = age(S.customer.birthday, S.visit.date);
  const decade = myAge == null ? null : Math.floor(myAge / 10) * 10;
  const latest = new Map();
  for (const v of visits) {
    if (!v.summary || v.customerId === S.customer.id) continue;
    const c = cmap.get(v.customerId);
    if (!c || c.sex !== S.customer.sex) continue;
    const a = age(c.birthday, v.date);
    if (a == null || Math.floor(a / 10) * 10 !== decade) continue;
    if (!latest.has(c.id) || latest.get(c.id).date < v.date) latest.set(c.id, v);
  }
  const list = [...latest.values()];
  const refs = { n: list.length, label: `${S.customer.sex === 'F' ? 'women' : 'men'} ${decade}–${decade + 9}`, cats: {} };
  if (list.length >= 3) {
    for (const c of CATEGORIES) {
      const sc = list.map((v) => v.summary.cats?.[c.id]?.score).filter((x) => x != null);
      const zones = {};
      for (const z of c.zones) {
        const zv = list.map((v) => v.summary.cats?.[c.id]?.zones?.[z]).filter((x) => x != null);
        if (zv.length) zones[z] = zv.reduce((a, b) => a + b, 0) / zv.length;
      }
      refs.cats[c.id] = { score: sc.reduce((a, b) => a + b, 0) / Math.max(1, sc.length), zones };
    }
  }
  S.refs = refs;
}

function refNote() {
  const r = S.refs;
  if (!r) return '';
  if (r.n < 3) return `Clinic reference for ${r.label}: builds up automatically once 3+ other patients of this group are saved (now ${r.n}).`;
  return `Reference = average of ${r.n} other patients in your clinic (${r.label}).`;
}

// ------------------------------------------------------------------ 4. analysis
function renderAnalysis() {
  const sum = S.visit?.summary;
  if (!sum) return;
  const items = [...CATEGORIES.map((c) => ({ id: c.id, label: c.label, score: sum.cats[c.id].score })),
    { id: 'tone', label: 'Skin tone', score: null }, { id: 'structure', label: 'Face structure', score: null }];
  $('#anMenu').innerHTML = items.map((it) => `<button data-c="${it.id}" class="${S.cat === it.id ? 'on' : ''}">${esc(it.label)}<span>${it.score ?? ''}</span></button>`).join('');
  $$('#anMenu button').forEach((b) => b.addEventListener('click', () => { S.cat = b.dataset.c; renderAnalysis(); }));
  if (!S.photos[S.anPos]) S.anPos = S.photos.front ? 'front' : Object.keys(S.photos)[0];
  if (S.cat === 'structure') S.anPos = 'front';
  $$('#anPos button').forEach((b) => { b.classList.toggle('on', b.dataset.pos === S.anPos); b.disabled = !S.photos[b.dataset.pos] || (S.cat === 'structure' && b.dataset.pos !== 'front'); });
  drawAnalysisImage();
  $('#anResult').innerHTML = S.cat === 'tone' ? toneHtml() : S.cat === 'structure' ? structureHtml() : categoryHtml(S.cat);
  bindQuiz($('#anResult'));
}

function drawAnalysisImage() {
  const p = S.photos[S.anPos];
  const cv = $('#anCanvas');
  if (!p) return;
  const [L, M] = CAT_VIEW[S.cat];
  const ctx = cv.getContext('2d');
  const H = 1500;
  const ref = renderImage(p, 'N', '', H);
  cv.width = ref.width; cv.height = ref.height;
  if (S.lamp) ctx.drawImage(ref, 0, 0);
  else if (M === 'STRUCT') drawPanel(ctx, p, 'N', 'STRUCT', 0, 0, cv.width, cv.height);
  else ctx.drawImage(renderImage(p, L, S.anZones ? 'ZONES' : M, H), 0, 0);
  $('#anZones').classList.toggle('primary', S.anZones);
}

function categoryHtml(cat) {
  const sum = S.visit.summary;
  const def = CATEGORIES.find((c) => c.id === cat);
  const c = sum.cats[cat];
  const ref = S.refs?.cats?.[cat];
  const ex = EXPLAIN[cat];
  const zones = ZONE_ORDER.filter((z) => c.zones[z] != null);
  const bars = zoneBars([
    ...zones.map((z) => ({ label: `${ZONE_LETTER[z]}`, value: c.zones[z], ref: ref?.zones?.[z] })),
    { label: 'Avg', value: c.score, ref: ref?.score },
  ]);
  const raw = (z) => {
    const r = sum.zoneRows.find((x) => x.zone === z) || {};
    return { pores: `${r.pores} pores`, wrinkles: `${r.wrinkleMm} mm lines`, spots: `${r.spotPct}% · ${r.spots} spots`,
      deep: `${r.diffusePct}%`, sebum: `${r.shinePct}% shiny`, redness: `${r.rednessPct}%`, texture: `${r.scars} depressions` }[cat];
  };
  let extra = '';
  if (cat === 'deep' || cat === 'spots') {
    extra = `<p class="explain">${sum.melasmaPattern
      ? `<b>Pattern: ${esc(sum.melasmaPattern)}</b>, which can fit melasma. Confirm clinically.`
      : 'No large symmetric patch pattern.'}</p>`;
  }
  if (cat === 'sebum') extra = skinTypeHtml();
  return `<div class="panel">
      <div class="panel-head"><h2>${esc(def.label)}</h2><span class="lvl ${c.level}">${c.level}</span></div>
      <div class="score-big"><span class="num">${c.score}</span><span class="of">/ 100${ref ? ` · reference ${Math.round(ref.score)}` : ''}</span></div>
      ${stateBar(c.score, ref?.score)}
      ${ref ? `<p class="explain">${c.score > ref.score + 5 ? `Higher than average for ${esc(S.refs.label)} by <b>${Math.round(c.score - ref.score)}</b> points.` : c.score < ref.score - 5 ? `Better than average for ${esc(S.refs.label)}.` : `Around the average for ${esc(S.refs.label)}.`}</p>` : ''}
      <div class="ref-note">${esc(refNote())}</div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>By zone</h2></div>
      ${bars}
      <div class="legend"><span><i style="background:#f59e0b"></i>This patient</span>${ref ? '<span><i style="background:#cbd5e1"></i>Reference</span>' : ''}</div>
      <table class="zt"><tr><th>Zone</th><th>Score</th><th>Measured</th></tr>
      ${zones.map((z) => `<tr><td><span class="zl">${ZONE_LETTER[z]}</span>${ZONE_LABEL[z]}</td><td>${c.zones[z]}</td><td>${raw(z)}</td></tr>`).join('')}</table>
    </div>
    <div class="panel explain">${extra}
      <h4>What it shows</h4><p>${ex.what}</p><h4>Why</h4><p>${ex.why}</p><h4>Care &amp; treatment ideas</h4><p>${ex.care}</p>
    </div>`;
}

function finalSkinType() {
  const v = S.visit;
  if (v.finalType) return v.finalType;
  const a = v.answers || {};
  const photo = v.summary.skinType;
  if (a.shine === 'all') return 'Oily';
  if (a.shine === 'tzone') return 'Combination';
  if (a.shine === 'no' && (a.tight === 'yes' || a.flake === 'yes')) return 'Dry';
  if (a.shine === 'no' && a.tight === 'no' && a.flake === 'no') return 'Normal';
  if (a.tight === 'yes' && a.flake === 'yes') return 'Dry';
  return photo === 'Dry-leaning' ? 'Dry' : photo;
}

function skinTypeHtml() {
  const v = S.visit, a = v.answers || {};
  const q = (key, label, opts) => `<div class="q"><span>${label}</span><div class="seg small" data-q="${key}">${
    opts.map(([val, t]) => `<button data-v="${val}" class="${a[key] === val ? 'on' : ''}">${t}</button>`).join('')}</div></div>`;
  const ft = finalSkinType();
  return `<h4>Skin type: <span class="lvl">${esc(ft)}</span></h4>
    <p>Photo estimate: <b>${esc(v.summary.skinType)}</b> (T-zone shine ${v.summary.tShine}% · cheeks ${v.summary.cShine}%).
    A photo shows oil, not dryness, so confirm with 3 questions:</p>
    <div class="qs">
      ${q('shine', 'Shiny by midday?', [['no', 'No'], ['tzone', 'T-zone only'], ['all', 'All over']])}
      ${q('tight', 'Feels tight after washing?', [['no', 'No'], ['yes', 'Yes']])}
      ${q('flake', 'Flaky or rough patches?', [['no', 'No'], ['yes', 'Yes']])}
      <div class="q"><span>Final skin type (tap to set):</span><div class="seg small" data-final>
      ${['Dry', 'Normal', 'Combination', 'Oily'].map((t) => `<button data-t="${t}" class="${ft === t ? 'on' : ''}">${t}</button>`).join('')}</div></div>
    </div>`;
}

function bindQuiz(root) {
  root.querySelectorAll('[data-q] button').forEach((b) => b.addEventListener('click', () => {
    const key = b.parentElement.dataset.q;
    S.visit.answers[key] = S.visit.answers[key] === b.dataset.v ? undefined : b.dataset.v;
    S.visit.finalType = null;
    saveVisitSoon();
    S.screen === 'total' ? renderTotal() : renderAnalysis();
  }));
  root.querySelectorAll('[data-final] button').forEach((b) => b.addEventListener('click', () => {
    S.visit.finalType = b.dataset.t;
    saveVisitSoon();
    S.screen === 'total' ? renderTotal() : renderAnalysis();
  }));
}

function underEye(d) {
  if (d == null) return 'n/a';
  if (d < 2) return 'none';
  return `${d} L* darker${d > 5 ? ' (visible)' : ''}`;
}

function toneHtml() {
  const t = S.visit.summary.tone;
  const sw = (rgb, lab) => `<div><i style="background:rgb(${rgb.join(',')})"></i>${lab}</div>`;
  return `<div class="panel">
      <div class="panel-head"><h2>Skin tone</h2><span class="lvl">${esc(t.category)}</span></div>
      <div class="score-big"><span class="num">${t.brightness}%</span><span class="of">brightness (0 = black, 100 = white)</span></div>
      <div class="tone-swatch">${sw(t.rgb, 'Average')}${Object.entries(t.zones).map(([z, v]) => sw(v.rgb, `${ZONE_LETTER[z]} ${v.L}`)).join('')}</div>
      <dl class="kv" style="margin-top:12px">
        <dt>Tone category (ITA°)</dt><dd>${esc(t.category)} (${t.ita}°)</dd>
        <dt>Evenness between zones (lower = more even)</dt><dd>${t.evenness}</dd>
        <dt>Under-eye darkness vs cheeks</dt><dd>${underEye(t.underEyeDiff)}</dd>
      </dl>
    </div>
    <div class="panel explain"><h4>How to use it</h4>
      <p>Brightness and tone are measured from the normal-light photo, so keep the same light at every visit to compare. An under-eye difference above about 5 usually shows as visible dark circles.</p></div>`;
}

function structureHtml() {
  const st = S.visit.structure;
  if (!st) return '<div class="panel">A front photo is needed for face structure.</div>';
  const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');
  const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');
  const poses = S.visit.poses || {};
  return `<div class="panel">
    <div class="panel-head"><h2>Face structure</h2><span class="lvl">${esc(st.shape)}</span></div>
    <dl class="kv">
      <dt>Symmetry score</dt><dd>${st.symmetry.toFixed(0)} / 100</dd>
      <dt>Lower : middle third (ideal ≈ 1.0)</dt><dd>${f2(st.thirds.lowerToMiddle)}</dd>
      <dt>Chin : upper lip (ideal ≈ 2.0)</dt><dd>${f2(st.lowerFace.ratio)}</dd>
      <dt>Lower : upper lip (ideal ≈ 1.6)</dt><dd>${f2(st.lips.ratio)}</dd>
      <dt>Eye gap : eye width (ideal ≈ 1.0)</dt><dd>${f2(st.fifths.interToEye)}</dd>
      <dt>Canthal tilt R / L</dt><dd>${f1(st.canthalTilt.right)}° / ${f1(st.canthalTilt.left)}°</dd>
      <dt>Face length : width</dt><dd>${f2(st.ratios.lengthToWidth)}</dd>
      <dt>Jaw : cheekbone width</dt><dd>${f2(st.ratios.jawToCheek)}</dd>
      <dt>Head angle front / left / right</dt><dd>${['front', 'left', 'right'].map((s) => (poses[s] == null ? '–' : `${Math.abs(poses[s])}°`)).join(' / ')}</dd>
    </dl></div>
    <div class="panel explain"><p>Lines: blue = midline, yellow = facial thirds (top line approximate: hairline is not detected), purple = eye fifths,
    green = forehead / cheekbone / jaw width, pink = eye tilt. Tap the image and use <b>∠ Angle</b> or <b>📏 Length</b> for your own measurements (chin, nose, jaw angles).</p></div>`;
}

function initAnalysis() {
  $$('#anPos button').forEach((b) => b.addEventListener('click', () => { S.anPos = b.dataset.pos; renderAnalysis(); }));
  $('#anZones').addEventListener('click', () => { S.anZones = !S.anZones; drawAnalysisImage(); });
  const lamp = $('#anLamp');
  lamp.addEventListener('pointerdown', (e) => { e.preventDefault(); S.lamp = true; drawAnalysisImage(); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => lamp.addEventListener(ev, () => { if (S.lamp) { S.lamp = false; drawAnalysisImage(); } }));
  $('#anCanvas').addEventListener('click', () => {
    const p = S.photos[S.anPos];
    const [L, M] = CAT_VIEW[S.cat];
    if (p) openPhotoViewer(p, L, M === 'STRUCT' ? '' : S.anZones ? 'ZONES' : M);
  });
}

// ------------------------------------------------------------------ 5. total
function thumb(p, L, M) {
  if (!p) return '';
  return renderImage(p, L, M, 700).toDataURL('image/jpeg', 0.85);
}

function renderTotal() {
  const v = S.visit, sum = v?.summary, c = S.customer;
  if (!sum) return;
  const p = S.photos.front || Object.values(S.photos)[0];
  const rows = CATEGORIES.map((cat) => {
    const x = sum.cats[cat.id];
    const ref = S.refs?.cats?.[cat.id]?.score;
    return `<div class="row"><div>${esc(cat.label)}</div>${stateBar(x.score, ref)}
      <div class="sc">${x.score}${ref != null ? ` <small>/ ${Math.round(ref)}</small>` : ''}</div><div class="lv"><span class="lvl ${x.level}">${x.level}</span></div></div>`;
  }).join('');
  const warn = [];
  if (sum.lowRes) warn.push('Photo resolution is low for pores: move closer or use the back camera.');
  const exp = Object.values(S.photos).map((ph) => ph.result?.exposure).filter(Boolean);
  if (exp.some((e) => e < 80)) warn.push('Some photos are dark, so results are less reliable.');
  if (exp.some((e) => e > 210)) warn.push('Some photos are very bright: shine and pigment may be under-read.');
  if (!S.photos.left || !S.photos.right) warn.push('Side photos are missing: cheek results come from the front photo.');
  const st = v.structure;
  const tone = sum.tone;
  $('#totalBody').innerHTML = `
    <div class="panel full">
      <div class="t-head">
        <div><div class="name">${esc(c?.name)}</div>
          <div class="muted">${c?.sex === 'F' ? 'Female' : 'Male'} · ${age(c?.birthday, v.date) ?? '?'} years · ${fmtDate(v.date)}${v.adviser ? ` · Adviser: ${esc(v.adviser)}` : ''}</div></div>
        <div class="muted" style="text-align:right">${esc($('#clinicName').value.trim())}</div>
      </div>
    </div>
    ${warn.length ? `<div class="panel full warn">${warn.map(esc).join('<br>')}</div>` : ''}
    <div class="panel">
      <div class="t-imgs">
        <figure><img src="${thumb(p, 'N', '')}" alt=""><figcaption>Normal</figcaption></figure>
        <figure><img src="${thumb(p, 'P', 'F')}" alt=""><figcaption>Polarized-style: spots</figcaption></figure>
        <figure><img src="${thumb(p, 'U', 'S')}" alt=""><figcaption>UV-style: sebum</figcaption></figure>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Results</h2><span class="muted" style="font-size:12px">score / reference</span></div>
      <div class="t-rows">${rows}</div>
      <div class="ref-note">${esc(refNote())}</div>
    </div>
    <div class="panel third">${skinTypeHtml()}</div>
    <div class="panel third">
      <div class="panel-head"><h2>Skin tone</h2><span class="lvl">${esc(tone.category)}</span></div>
      <div class="tone-swatch"><div><i style="background:rgb(${tone.rgb.join(',')})"></i>${tone.brightness}%</div></div>
      <dl class="kv"><dt>Brightness</dt><dd>${tone.brightness}%</dd><dt>Evenness</dt><dd>${tone.evenness}</dd>
      <dt>Under-eye darkness</dt><dd>${underEye(tone.underEyeDiff)}</dd>
      <dt>Pigment pattern</dt><dd>${esc(sum.melasmaPattern || 'none')}</dd></dl>
    </div>
    <div class="panel third">
      <div class="panel-head"><h2>Face structure</h2><span class="lvl">${esc(st?.shape || 'n/a')}</span></div>
      ${st ? `<dl class="kv"><dt>Symmetry</dt><dd>${st.symmetry.toFixed(0)}/100</dd><dt>Lower : middle third</dt><dd>${st.thirds.lowerToMiddle.toFixed(2)}</dd>
      <dt>Chin : upper lip</dt><dd>${st.lowerFace.ratio.toFixed(2)}</dd><dt>Canthal tilt R/L</dt><dd>${st.canthalTilt.right.toFixed(1)}° / ${st.canthalTilt.left.toFixed(1)}°</dd></dl>` : ''}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Advice</h2></div>
      <textarea class="notes" id="advice" placeholder="Findings and advice for the patient…">${esc(v.advice)}</textarea>
      <div class="print-only">${esc(v.advice)}</div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Recommended treatments &amp; products</h2></div>
      <textarea class="notes" id="recommend" placeholder="e.g. Laser toning x5, retinol 0.3% at night, SPF50 daily…">${esc(v.recommend)}</textarea>
      <div class="print-only">${esc(v.recommend)}</div>
    </div>
    <div class="panel full disclaimer">Image-based, indicative assessment to support the consultation. It is not a medical diagnosis.
      "Polarized-style" and "UV-style" images are computed from a normal photo and are not real polarised or UV photographs.
      Results depend on light, camera and distance, so compare visits taken in the same setup.</div>`;
  bindQuiz($('#totalBody'));
  for (const k of ['advice', 'recommend']) {
    $(`#${k}`).addEventListener('input', (e) => {
      v[k] = e.target.value;
      e.target.nextElementSibling.textContent = v[k];
      saveVisitSoon();
    });
  }
}

// ------------------------------------------------------------------ 6. history
async function renderHistory() {
  const visits = (await db.visits(S.customer.id)).filter((v) => v.summary);
  const cats = [{ id: 'all', label: 'All' }, ...CATEGORIES];
  $('#histCats').innerHTML = cats.map((c) => `<button data-c="${c.id}" class="${S.histCat === c.id ? 'on' : ''}">${esc(c.label)}</button>`).join('');
  $$('#histCats button').forEach((b) => b.addEventListener('click', () => { S.histCat = b.dataset.c; renderHistory(); }));
  const body = $('#historyBody');
  if (!visits.length) { body.innerHTML = '<div class="panel">No saved visits yet.</div>'; return; }
  const last = visits.slice(-10);
  const labels = last.map((v) => shortDate(v.date));
  const series = (S.histCat === 'all' ? CATEGORIES : CATEGORIES.filter((c) => c.id === S.histCat))
    .map((c) => ({ name: c.label, color: CAT_COLORS[c.id], values: last.map((v) => v.summary.cats[c.id]?.score ?? null) }));
  body.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>${S.histCat === 'all' ? 'All categories' : esc(CATEGORIES.find((c) => c.id === S.histCat).label)}</h2>
      <span class="muted">last ${last.length} visit${last.length > 1 ? 's' : ''} · lower is better</span></div>
      ${lineChart(labels, series)}
      ${series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="panel"><div class="ht-scroll"><table class="ht">
      <tr><th>Date</th>${CATEGORIES.map((c) => `<th>${esc(c.label)}</th>`).join('')}<th>Skin type</th><th></th></tr>
      ${[...visits].reverse().map((v) => `<tr><td>${fmtDate(v.date)}</td>${CATEGORIES.map((c) => `<td>${v.summary.cats[c.id]?.score ?? ''}</td>`).join('')}
        <td>${esc(v.finalType || v.summary.skinType)}</td>
        <td><button class="btn small" data-open="${v.id}">Open</button> <button class="btn small danger" data-del="${v.id}">Delete</button></td></tr>`).join('')}
    </table></div></div>
    <div class="panel"><div class="panel-head"><h2>Advice history</h2></div>
      ${[...visits].reverse().filter((v) => v.advice || v.recommend).map((v) => `<div class="advice-item"><div class="d">${fmtDate(v.date)}${v.adviser ? ` · ${esc(v.adviser)}` : ''}</div>
        ${v.advice ? `<p>${esc(v.advice)}</p>` : ''}${v.recommend ? `<p><b>Plan:</b> ${esc(v.recommend)}</p>` : ''}</div>`).join('') || '<p class="muted">No advice written yet.</p>'}
    </div>`;
  body.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openVisit(b.dataset.open)));
  body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this visit and its photos? This cannot be undone.')) return;
    await db.deleteVisit(b.dataset.del);
    S.runtime.delete(b.dataset.del);
    if (S.visit?.id === b.dataset.del) { resetVisit(); }
    S.refs = null;
    updateFlow();
    renderHistory();
  }));
}

// ------------------------------------------------------------------ 7. compare
async function renderCompare() {
  const visits = (await db.visits(S.customer.id)).filter((v) => v.summary);
  const body = $('#compareBody');
  if (visits.length < 2) {
    body.innerHTML = '<div class="panel">Compare needs at least 2 saved visits for this customer. Come back after the next session.</div>';
    $('#cmpA').innerHTML = ''; $('#cmpB').innerHTML = '';
    return;
  }
  const C = S.cmp;
  if (!visits.find((v) => v.id === C.a)) C.a = visits[0].id;
  if (!visits.find((v) => v.id === C.b) || C.b === C.a) C.b = visits[visits.length - 1].id;
  const opts = (sel) => visits.map((v) => `<option value="${v.id}" ${v.id === sel ? 'selected' : ''}>${fmtDate(v.date)}</option>`).join('');
  $('#cmpA').innerHTML = opts(C.a);
  $('#cmpB').innerHTML = opts(C.b);
  $('#cmpMode').innerHTML = ALL_MODES.filter(([, m]) => m !== 'STRUCT').map(([, , lab], i) => `<option value="${i}" ${i === C.mode ? 'selected' : ''}>${lab}</option>`).join('');
  $$('#cmpPos button').forEach((b) => b.classList.toggle('on', b.dataset.pos === C.pos));

  const A = visits.find((v) => v.id === C.a), B = visits.find((v) => v.id === C.b);
  body.innerHTML = `<div class="cmp-imgs">
      <figure><figcaption>Date 1 · ${fmtDate(A.date)}</figcaption><canvas id="cmpCa"></canvas></figure>
      <figure><figcaption>Date 2 · ${fmtDate(B.date)}</figcaption><canvas id="cmpCb"></canvas></figure></div>
    <div class="progress on" id="cmpProg"><div class="spinner"></div><span>Preparing images…</span></div>
    <div class="panel"><div class="ht-scroll"><table class="ht">
      <tr><th>Category</th><th>${fmtDate(A.date)}</th><th>${fmtDate(B.date)}</th><th>Change</th></tr>
      ${CATEGORIES.map((c) => {
        const a = A.summary.cats[c.id].score, b = B.summary.cats[c.id].score, d = b - a;
        const cls = d < -2 ? 'good' : d > 2 ? 'bad' : '';
        const pct = a > 0 ? ` (${d > 0 ? '+' : ''}${Math.round((d / a) * 100)}%)` : '';
        return `<tr><td>${esc(c.label)}</td><td>${a}</td><td>${b}</td><td class="delta ${cls}">${d > 0 ? '+' : ''}${d}${pct}</td></tr>`;
      }).join('')}
    </table></div><p class="muted" style="font-size:13px">Lower scores are better. Green = improved. For a fair comparison, use the same room, light and distance (Ghost overlay).</p></div>`;

  await loadFaceModels().catch(() => {});
  const [L, M] = ALL_MODES[C.mode];
  for (const [v, id] of [[A, '#cmpCa'], [B, '#cmpCb']]) {
    const rt = v.id === S.visit?.id ? { photos: S.photos } : await loadVisitRuntime(v, [C.pos]);
    const p = rt.photos[C.pos];
    const cv = $(id);
    if (!cv) return;
    if (!p) { cv.width = 300; cv.height = 400; continue; }
    await tick();
    if (M) ensureResult(p);
    const img = renderImage(p, L, M, 1300);
    cv.width = img.width; cv.height = img.height;
    cv.getContext('2d').drawImage(img, 0, 0);
    cv.onclick = () => openPhotoViewer(ensureResult(p), L, M, v);
  }
  $('#cmpProg')?.classList.remove('on');
}

function initCompare() {
  $('#cmpA').addEventListener('change', (e) => { S.cmp.a = e.target.value; renderCompare(); });
  $('#cmpB').addEventListener('change', (e) => { S.cmp.b = e.target.value; renderCompare(); });
  $('#cmpMode').addEventListener('change', (e) => { S.cmp.mode = +e.target.value; renderCompare(); });
  $$('#cmpPos button').forEach((b) => b.addEventListener('click', () => { S.cmp.pos = b.dataset.pos; renderCompare(); }));
}

// ------------------------------------------------------------------ boot
function init() {
  initCustomer();
  initCapture();
  initImages();
  initAnalysis();
  initCompare();
  $$('#flow button').forEach((b) => b.addEventListener('click', () => !b.disabled && go(b.dataset.go)));
  $('#printTotal').addEventListener('click', () => window.print());
  loadFaceModels()
    .then(() => { $('#modelStatus').textContent = 'Face AI ready ✓ (runs on this device)'; })
    .catch((err) => {
      console.error(err);
      $('#modelStatus').textContent = 'Could not load the face AI. Check the internet connection and reload.';
      $('#modelStatus').classList.add('err');
      $('#modelStatus').closest('details').open = true;
    });
  refreshCustomers().then(updateFlow);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  window.__app = { S, go, importFiles, openVisit };
}
init();
