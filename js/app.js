import { loadFaceModels, detectVideo, detectImage, faceBox } from './face.js';
import { analysePhoto, summarise } from './analysis.js';
import { buildCollage, drawPanel, SLOTS } from './collage.js';
import { VIEWS } from './views.js';
import { measureStructure } from './structure.js';
import { ZONE_LABEL } from './regions.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ------------------------------------------------------------------ state
const CAPTURE_ORDER = ['front', 'right', 'left'];
const TARGET = {
  front: { yaw: 0, tol: 7, text: 'Face looking straight at the camera' },
  right: { yaw: 45, tol: 12, text: "Ask the patient to turn their head to THEIR LEFT (shows right cheek)" },
  left: { yaw: -45, tol: 12, text: "Ask the patient to turn their head to THEIR RIGHT (shows left cheek)" },
};
const MAX_SIDE = 4032;

const state = {
  facing: 'environment',
  photos: {}, // slot -> { slot, source, face, result }
  slot: 'front',
  stream: null,
  running: false,
  okFrames: 0,
  lastNose: null,
  view: 'original',
  zoomSlot: null,
  summary: null,
  structure: null,
  answers: {},
  finalType: null,
  notes: '',
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

function show(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  document.body.classList.toggle('capturing', id === 'capture');
  window.scrollTo(0, 0);
}

const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ------------------------------------------------------------------ home
function initHome() {
  $('#clinicName').value = store.get('clinicName') || '';
  $('#clinicName').addEventListener('input', (e) => store.set('clinicName', e.target.value));
  $('#patientName').addEventListener('input', updateTopPatient);
  const savedFacing = store.get('facing');
  if (savedFacing) setFacing(savedFacing);
  $$('#cameraSeg button').forEach((b) => b.addEventListener('click', () => setFacing(b.dataset.facing)));
  $('#startCamera').addEventListener('click', startCapture);
  $('#importFiles').addEventListener('change', (e) => importFiles([...e.target.files]));

  loadFaceModels()
    .then(() => {
      $('#modelStatus').textContent = 'Face AI ready ✓ (runs on this device)';
      $('#startCamera').disabled = false;
    })
    .catch((err) => {
      console.error(err);
      $('#modelStatus').textContent = 'Could not load the face AI. Check the internet connection and reload.';
      $('#modelStatus').classList.add('err');
    });
}

function setFacing(f) {
  state.facing = f;
  store.set('facing', f);
  $$('#cameraSeg button').forEach((b) => b.classList.toggle('on', b.dataset.facing === f));
}

function updateTopPatient() {
  $('#topPatient').textContent = $('#patientName').value.trim();
}

function info() {
  return {
    clinic: $('#clinicName').value.trim(),
    patient: $('#patientName').value.trim(),
    date: new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
  };
}

// ------------------------------------------------------------------ capture
const detCanvas = document.createElement('canvas');
const detCtx = detCanvas.getContext('2d', { willReadFrequently: true });

async function startCapture() {
  show('capture');
  state.slot = CAPTURE_ORDER.find((s) => !state.photos[s]) || 'front';
  updateSteps();
  await openCamera();
}

async function openCamera() {
  stopCamera();
  const video = $('#video');
  $('#camWrap').classList.toggle('mirror', state.facing === 'user');
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: state.facing }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
  } catch (e) {
    console.error(e);
    toast('Camera not available. Allow camera access in Safari settings (Safari needs https).', 5000);
    show('home');
    return;
  }
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  await new Promise((r) => (video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
  state.running = true;
  state.okFrames = 0;
  loop();
}

function stopCamera() {
  state.running = false;
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
}

function loop() {
  if (!state.running) return;
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

function brightness(face, dw) {
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

function evaluate(face, dw, dh) {
  const ov = $('#overlay');
  const video = $('#video');
  if (ov.width !== video.videoWidth) { ov.width = video.videoWidth; ov.height = video.videoHeight; }
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, ov.width, ov.height);
  const k = ov.width / dw;
  const t = TARGET[state.slot];
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
    const L = brightness(face, dw);

    checks.angle = Math.abs(yaw - t.yaw) <= t.tol;
    checks.dist = faceH >= 0.36 && faceH <= 0.78 && cx > 0.2 && cx < 0.8 && cy > 0.2 && cy < 0.8;
    checks.level = Math.abs(roll) < 8 && Math.abs(pitch) < 14;
    checks.light = L.mean > 75 && L.mean < 215 && (state.slot !== 'front' || L.ratio > 0.72);

    // hint priority
    if (!checks.dist) {
      if (faceH < 0.36) hint = 'Move closer: the face should fill most of the screen';
      else if (faceH > 0.78) hint = 'Move back a little';
      else hint = 'Centre the face on screen';
    } else if (!checks.angle) {
      const diff = yaw - t.yaw;
      if (state.slot === 'front') hint = diff > 0 ? 'Turn head slightly to THEIR RIGHT' : 'Turn head slightly to THEIR LEFT';
      else if (Math.sign(yaw) !== Math.sign(t.yaw) || Math.abs(yaw) < Math.abs(t.yaw) - t.tol) {
        hint = `Turn head further to ${state.slot === 'right' ? 'THEIR LEFT' : 'THEIR RIGHT'}`;
      }
      else hint = 'Turn back a little (too far)';
    } else if (!checks.level) {
      hint = Math.abs(roll) >= 8 ? "Keep the head straight (don't tilt to the shoulder)" : 'Keep the chin level';
    } else if (!checks.light) {
      hint = L.mean <= 75 ? 'Too dark: add light in front of the face' : L.mean >= 215 ? 'Too bright: reduce light / avoid flash' : 'Light is uneven: face the light source';
    }

    // overlay: face contour
    ctx.save();
    ctx.lineWidth = Math.max(2, ov.width / 500);
    const allOk = Object.values(checks).every(Boolean);
    ctx.strokeStyle = allOk ? 'rgba(34,197,94,0.95)' : 'rgba(255,255,255,0.7)';
    const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
      152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
    ctx.beginPath();
    OVAL.forEach((i, n) => { const p = face.pts[i]; n ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k); });
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = allOk ? 'rgba(34,197,94,0.8)' : 'rgba(255,255,255,0.45)';
    for (let i = 0; i < 468; i += 6) {
      const p = face.pts[i];
      ctx.fillRect(p.x * k - 1.5, p.y * k - 1.5, 3, 3);
    }
    ctx.restore();

    // stability
    const nose = face.pts[1];
    const moved = state.lastNose ? Math.hypot(nose.x - state.lastNose.x, nose.y - state.lastNose.y) / dw : 1;
    state.lastNose = nose;
    if (allOk && moved < 0.006) state.okFrames++;
    else state.okFrames = 0;
  }

  $('#instruction').textContent = t.text;
  $('#hint').textContent = hint || (checks.face ? 'Hold still…' : '');
  $$('#checks span').forEach((s) => {
    const v = checks[s.dataset.k];
    s.classList.toggle('ok', v);
    s.classList.toggle('no', !v);
  });
  const ready = state.okFrames > 0;
  $('#shutter').classList.toggle('ready', ready);
  if ($('#autoCap').checked && state.okFrames >= 14 && !evaluate.busy) {
    state.okFrames = 0;
    capture();
  }
}

function setGauge(yaw) {
  const range = 70; // -70..70
  const pos = (v) => `${((Math.max(-range, Math.min(range, v)) + range) / (2 * range)) * 100}%`;
  const t = TARGET[state.slot];
  const zone = $('#gaugeZone');
  zone.style.left = pos(t.yaw - t.tol);
  zone.style.width = `${((2 * t.tol) / (2 * range)) * 100}%`;
  // needle: left side of gauge = turned to their right (negative yaw)
  $('#gaugeNeedle').style.left = yaw == null ? '50%' : pos(yaw);
  $('#gaugeNeedle').style.opacity = yaw == null ? 0.3 : 1;
  $('#yawText').textContent = yaw == null ? 'n/a' : `${Math.abs(yaw).toFixed(0)}°`;
}

async function capture() {
  if (evaluate.busy) return;
  evaluate.busy = true;
  try {
    const video = $('#video');
    const flash = $('#flash');
    flash.classList.add('on');
    setTimeout(() => flash.classList.remove('on'), 60);
    const c = document.createElement('canvas');
    const s = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    c.width = Math.round(video.videoWidth * s);
    c.height = Math.round(video.videoHeight * s);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    const face = detectImage(c);
    if (!face) { toast('No face in the photo, try again'); return; }
    const slot = state.slot;
    state.photos[slot] = { slot, source: c, face, result: null };
    const off = Math.abs(face.pose.yaw - TARGET[slot].yaw) > TARGET[slot].tol + 5;
    toast(off ? `Saved ${slotName(slot)}, but the angle is ${Math.abs(face.pose.yaw).toFixed(0)}°. Retake if needed.`
      : `${slotName(slot)} ✓`);
    const next = CAPTURE_ORDER.find((x) => !state.photos[x]);
    if (next) state.slot = next;
    updateSteps();
    if (!next) {
      await new Promise((r) => setTimeout(r, 500));
      goResults();
    }
  } finally {
    setTimeout(() => (evaluate.busy = false), 900);
  }
}

function slotName(s) {
  return { front: 'Front', right: 'Right side', left: 'Left side' }[s];
}

function updateSteps() {
  $$('#steps .step').forEach((b) => {
    const slot = b.dataset.slot;
    b.classList.toggle('current', slot === state.slot);
    b.classList.toggle('done', !!state.photos[slot]);
    const cv = b.querySelector('canvas');
    cv.width = 108; cv.height = 144;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (state.photos[slot]) drawPanel(ctx, state.photos[slot], 'original', 0, 0, cv.width, cv.height);
  });
  $('#toResults').disabled = !Object.keys(state.photos).length;
}

function initCapture() {
  $('#shutter').addEventListener('click', capture);
  $('#camCancel').addEventListener('click', () => { stopCamera(); show(Object.keys(state.photos).length ? 'results' : 'home'); if (state.summary) renderCollage(); });
  $('#camSwitch').addEventListener('click', () => { setFacing(state.facing === 'user' ? 'environment' : 'user'); openCamera(); });
  $('#toResults').addEventListener('click', goResults);
  $$('#steps .step').forEach((b) => b.addEventListener('click', () => {
    state.slot = b.dataset.slot;
    state.okFrames = 0;
    updateSteps();
  }));
}

// ------------------------------------------------------------------ import
async function importFiles(files) {
  if (!files.length) return;
  try {
    await loadFaceModels();
  } catch {
    toast('Face AI not loaded yet');
    return;
  }
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
      if (face) found.push({ source: c, face });
      else toast(`No face found in ${f.name}`);
    } catch (e) {
      console.error(e);
      toast(`Could not read ${f.name}`);
    }
  }
  $('#importFiles').value = '';
  if (!found.length) return;
  // assign automatically by head angle
  state.photos = {};
  const byYaw = [...found].sort((a, b) => a.face.pose.yaw - b.face.pose.yaw);
  const take = (slot, item) => { state.photos[slot] = { slot, ...item, result: null }; };
  if (found.length === 1) take('front', found[0]);
  else {
    const frontIdx = found.reduce((bi, p, i) => (Math.abs(p.face.pose.yaw) < Math.abs(found[bi].face.pose.yaw) ? i : bi), 0);
    take('front', found[frontIdx]);
    const rest = byYaw.filter((p) => p !== found[frontIdx]);
    const pos = rest.filter((p) => p.face.pose.yaw > 0), neg = rest.filter((p) => p.face.pose.yaw <= 0);
    if (pos.length) take('right', pos[pos.length - 1]);
    if (neg.length) take('left', neg[0]);
  }
  goResults();
}

// ------------------------------------------------------------------ results
async function goResults() {
  stopCamera();
  show('results');
  state.summary = null;
  $('#report').innerHTML = '';
  $('#progress').classList.add('on');
  renderTabs();
  renderCollage();
  for (const slot of CAPTURE_ORDER) {
    const p = state.photos[slot];
    if (!p) continue;
    if (!p.result) {
      $('#progressText').textContent = `Analysing ${slotName(slot).toLowerCase()} photo…`;
      await tick();
      try {
        p.result = analysePhoto(p.source, p.face);
      } catch (e) {
        console.error(e);
        toast(`Analysis failed for ${slotName(slot)}: ${e.message}`);
      }
    }
  }
  const res = {};
  for (const s of CAPTURE_ORDER) if (state.photos[s]?.result) res[s] = state.photos[s].result;
  state.summary = summarise(res);
  state.structure = state.photos.front ? measureStructure(state.photos.front.face) : null;
  state.finalType = null;
  $('#progress').classList.remove('on');
  renderCollage();
  renderReport();
}

function renderTabs() {
  for (const sel of ['#viewTabs', '#zoomTabs']) {
    const el = $(sel);
    el.innerHTML = '';
    for (const v of VIEWS) {
      const b = document.createElement('button');
      b.textContent = v.label;
      b.dataset.view = v.id;
      b.title = v.hint;
      b.classList.toggle('on', v.id === state.view);
      b.addEventListener('click', () => setView(v.id));
      el.appendChild(b);
    }
  }
}

function setView(v) {
  if (v !== 'original' && v !== 'structure' && !state.summary) { toast('Still analysing…'); return; }
  state.view = v;
  $$('.views button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  renderCollage();
  if (!$('#zoom').hidden) renderZoom();
}

let collageCanvas = null;
function renderCollage() {
  collageCanvas = buildCollage(state.photos, state.view, info());
  const c = $('#collage');
  c.width = collageCanvas.width;
  c.height = collageCanvas.height;
  c.getContext('2d').drawImage(collageCanvas, 0, 0);
}

function initResults() {
  $('#collage').addEventListener('click', (e) => {
    const c = $('#collage');
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * c.width;
    const n = Math.max(0, Math.min(2, Math.floor((x - 24) / ((c.width - 48) / 3))));
    const slot = SLOTS[n].id;
    if (!state.photos[slot]) return;
    state.zoomSlot = slot;
    $('#zoom').hidden = false;
    renderZoom();
  });
  $('#zoomClose').addEventListener('click', () => ($('#zoom').hidden = true));
  $('#retake').addEventListener('click', () => startCapture());
  $('#newPatient').addEventListener('click', () => {
    if (!confirm('Start a new patient? Current photos will be cleared.')) return;
    state.photos = {};
    state.summary = null;
    state.answers = {};
    state.finalType = null;
    state.notes = '';
    state.view = 'original';
    $('#patientName').value = '';
    updateTopPatient();
    show('home');
  });
  $('#saveCollage').addEventListener('click', saveCollage);
  $('#printReport').addEventListener('click', () => window.print());
}

function renderZoom() {
  const p = state.photos[state.zoomSlot];
  const c = $('#zoomCanvas');
  const pw = 1500, ph = 2000;
  c.width = pw;
  c.height = ph;
  drawPanel(c.getContext('2d'), p, state.view, 0, 0, pw, ph);
}

async function saveCollage() {
  if (!collageCanvas) return;
  const blob = await new Promise((r) => collageCanvas.toBlob(r, 'image/jpeg', 0.92));
  const who = (info().patient || 'patient').replace(/[^\w-]+/g, '_');
  const name = `${who}_${new Date().toISOString().slice(0, 10)}_${state.view}.jpg`;
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

// ------------------------------------------------------------------ report
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');

function scoreCard(title, level, score, body, kv) {
  return `<div class="card"><h3>${title}<span class="lvl ${level}">${level}</span></h3>
    <div class="bar"><div style="width:${Math.max(3, score).toFixed(0)}%"></div></div>
    ${body}
    <dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>`;
}

function topZones(field, n = 2) {
  const rows = [...(state.summary.zoneRows || [])].filter((z) => z[field] > 0).sort((a, b) => b[field] - a[field]);
  return rows.slice(0, n).map((z) => ZONE_LABEL[z.zone]).join(', ') || 'none';
}

function finalSkinType() {
  if (state.finalType) return state.finalType;
  const a = state.answers;
  const photo = state.summary.skinType;
  if (a.shine === 'all') return 'Oily';
  if (a.shine === 'tzone') return 'Combination';
  if (a.shine === 'no' && (a.tight === 'yes' || a.flake === 'yes')) return 'Dry';
  if (a.shine === 'no' && a.tight === 'no' && a.flake === 'no') return 'Normal';
  if (a.tight === 'yes' && a.flake === 'yes') return 'Dry';
  return photo === 'Dry-leaning' ? 'Dry' : photo;
}

function renderReport() {
  const S = state.summary;
  const st = state.structure;
  if (!S) return;
  const q = (key, label, opts) => `<div class="q"><span>${label}</span><div class="seg" data-q="${key}">${
    opts.map(([v, t]) => `<button data-v="${v}" class="${state.answers[key] === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>`;
  const types = ['Dry', 'Normal', 'Combination', 'Oily'];
  const ft = finalSkinType();

  const skin = `<div class="card"><h3>Skin type<span class="lvl">${esc(ft)}</span></h3>
    <p>Photo estimate from shine: <b>${esc(S.skinType)}</b>. T-zone shine ${f1(S.tShine)}% · cheeks ${f1(S.cShine)}%.</p>
    <div class="bar"><div style="width:${Math.max(3, S.oilScore).toFixed(0)}%"></div></div>
    <p class="sub">A photo can show oil (shine) well, but not dryness. Ask these 3 questions to confirm:</p>
    <div class="qs">
      ${q('shine', 'Shiny by midday?', [['no', 'No'], ['tzone', 'T-zone only'], ['all', 'All over']])}
      ${q('tight', 'Feels tight after washing?', [['no', 'No'], ['yes', 'Yes']])}
      ${q('flake', 'Flaky or rough patches?', [['no', 'No'], ['yes', 'Yes']])}
    </div>
    <p class="sub" style="margin-top:12px">Final skin type (tap to override):</p>
    <div class="skin-final">${types.map((t) => `<button data-t="${t}" class="${ft === t ? 'on' : ''}">${t}</button>`).join('')}</div>
  </div>`;

  const pores = scoreCard('Pores', S.poreLevel, S.poreScore,
    `<p>Visible pores detected, most on: <b>${topZones('pores')}</b>.</p>`,
    [['Pores per cm² (nose + cheeks)', f1(S.poreDensity)]]);

  const texture = scoreCard('Texture & acne scars', S.textureLevel, S.textureScore,
    `<p>Possible scars / depressions marked in orange on the <i>Pores &amp; texture</i> view. Most on: <b>${topZones('scars')}</b>.</p>`,
    [['Depressions found', S.scarCount], ['Cheek roughness index', f1(S.rough)]]);

  const pig = scoreCard('Pigmentation & melasma', S.pigLevel, S.pigScore,
    `<p>${S.melasmaPattern
      ? `Patch pattern: <b>${esc(S.melasmaPattern)}</b>, which can fit melasma. Confirm clinically (Wood's lamp / dermoscopy).`
      : 'No large symmetric patch pattern found.'}
     See the <i>Brown spots</i> and <i>Blue light</i> views.</p>`,
    [['Pigmented area', `${f1(S.pigPct)}%`], ['Small spots', S.spots], ['Most on', topZones('pigmentPct')]]);

  const red = scoreCard('Redness & active spots', S.redLevel, S.redScore,
    `<p>Red areas shown on the <i>Red light</i> view; possible active spots are circled in white.</p>`,
    [['Red area', `${f1(S.redPct)}%`], ['Possible active spots', S.redSpots], ['Most on', topZones('rednessPct')]]);

  let structure = '';
  if (st) {
    const ang = (s) => (state.photos[s] ? `${Math.abs(state.photos[s].face.pose.yaw).toFixed(0)}°` : 'n/a');
    structure = `<div class="card"><h3>Face structure<span class="lvl">${esc(st.shape)}</span></h3>
      <p class="sub">Measured on the front photo. See the <i>Face structure</i> view. Upper third not measured (hairline is not detected).</p>
      <dl class="kv">
        <dt>Symmetry score</dt><dd>${st.symmetry.toFixed(0)} / 100</dd>
        <dt>Lower : middle third (ideal ≈ 1.0)</dt><dd>${f2(st.thirds.lowerToMiddle)}</dd>
        <dt>Chin : upper lip (ideal ≈ 2.0)</dt><dd>${f2(st.lowerFace.ratio)}</dd>
        <dt>Lower : upper lip (ideal ≈ 1.6)</dt><dd>${f2(st.lips.ratio)}</dd>
        <dt>Eye gap : eye width (ideal ≈ 1.0)</dt><dd>${f2(st.fifths.interToEye)}</dd>
        <dt>Canthal tilt R / L</dt><dd>${f1(st.canthalTilt.right)}° / ${f1(st.canthalTilt.left)}°</dd>
        <dt>Face length : width</dt><dd>${f2(st.ratios.lengthToWidth)}</dd>
        <dt>Jaw : cheekbone width</dt><dd>${f2(st.ratios.jawToCheek)}</dd>
        <dt>Head angle R / front / L</dt><dd>${ang('right')} / ${ang('front')} / ${ang('left')}</dd>
      </dl></div>`;
  }

  const rows = S.zoneRows.map((z) => `<tr><td>${ZONE_LABEL[z.zone]}</td><td>${f1(z.shinePct)}%</td><td>${z.pores}</td>
    <td>${z.scars}</td><td>${f1(z.pigmentPct)}%</td><td>${f1(z.rednessPct)}%</td></tr>`).join('');
  const zones = `<div class="card wide"><h3>By zone</h3><div class="zones-scroll"><table class="zones">
    <tr><th>Zone</th><th>Shine</th><th>Pores</th><th>Depressions</th><th>Pigment</th><th>Redness</th></tr>${rows}</table></div></div>`;

  const warn = [];
  if (S.lowRes) warn.push('Photo resolution is low for pores: move closer or use the back camera.');
  const exp = Object.values(state.photos).map((p) => p.result?.exposure).filter(Boolean);
  if (exp.some((e) => e < 80)) warn.push('Some photos are dark, so the results are less reliable.');
  if (exp.some((e) => e > 210)) warn.push('Some photos are very bright: shine and pigment may be under-read.');
  if (!state.photos.right || !state.photos.left) warn.push('Side photos are missing: cheek results come from the front photo only.');

  const notes = `<div class="card wide"><h3>Clinician notes</h3>
    <textarea class="notes no-print" id="notes" placeholder="Findings, plan, products, treatment options…">${esc(state.notes)}</textarea>
    <div class="print-only print-notes" id="printNotes">${esc(state.notes)}</div>
    <p class="disclaimer">Image-based, indicative assessment to support the consultation. It is not a medical diagnosis.
    Results depend on light, camera and distance, so compare visits taken in the same setup.</p></div>`;

  $('#report').innerHTML =
    (warn.length ? `<div class="card wide warn">${warn.map(esc).join('<br>')}</div>` : '') +
    skin + pores + texture + pig + red + structure + zones + notes;

  $$('#report .seg[data-q] button').forEach((b) => b.addEventListener('click', () => {
    const key = b.parentElement.dataset.q;
    state.answers[key] = state.answers[key] === b.dataset.v ? undefined : b.dataset.v;
    state.finalType = null;
    renderReport();
  }));
  $$('#report .skin-final button').forEach((b) => b.addEventListener('click', () => {
    state.finalType = b.dataset.t;
    renderReport();
  }));
  $('#notes').addEventListener('input', (e) => {
    state.notes = e.target.value;
    $('#printNotes').textContent = state.notes;
  });
}

// ------------------------------------------------------------------ boot
initHome();
initCapture();
initResults();
renderTabs();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.__app = { state, importFiles };
