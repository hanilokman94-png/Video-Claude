// Tiny SVG charts (no library).

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * Horizontal state bar: patient score with an optional reference marker.
 */
export function stateBar(score, ref) {
  const s = Math.max(0, Math.min(100, score));
  const r = ref == null ? null : Math.max(0, Math.min(100, ref));
  return `<div class="sbar"><div class="sbar-fill" style="width:${Math.max(2, s)}%"></div>${
    r == null ? '' : `<div class="sbar-ref" style="left:${r}%" title="Reference ${Math.round(r)}"></div>`}</div>`;
}

/**
 * Grouped vertical bars per zone: patient (filled) vs reference (outline).
 * items: [{ label, value, ref }]
 */
export function zoneBars(items, { height = 170 } = {}) {
  const W = Math.max(380, items.length * 64), H = height, pad = 26, base = H - 30;
  const bw = 20;
  const step = (W - pad) / Math.max(1, items.length);
  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">`;
  for (const g of [0, 25, 50, 75, 100]) {
    const y = base - (g / 100) * (base - 10);
    out += `<line x1="${pad}" x2="${W}" y1="${y}" y2="${y}" class="grid"/><text x="${pad - 5}" y="${y + 3}" class="axis" text-anchor="end">${g}</text>`;
  }
  items.forEach((it, i) => {
    const cx = pad + step * i + step / 2;
    const h = (Math.max(0, Math.min(100, it.value)) / 100) * (base - 10);
    out += `<rect x="${cx - bw - 1}" y="${base - h}" width="${bw}" height="${Math.max(1, h)}" rx="3" class="bar-pt"/>`;
    out += `<text x="${cx - bw / 2 - 1}" y="${base - h - 4}" class="val" text-anchor="middle">${Math.round(it.value)}</text>`;
    if (it.ref != null) {
      const rh = (Math.max(0, Math.min(100, it.ref)) / 100) * (base - 10);
      out += `<rect x="${cx + 1}" y="${base - rh}" width="${bw}" height="${Math.max(1, rh)}" rx="3" class="bar-ref"/>`;
      out += `<text x="${cx + bw / 2 + 1}" y="${base - rh - 4}" class="val ref" text-anchor="middle">${Math.round(it.ref)}</text>`;
    }
    out += `<text x="${cx}" y="${H - 10}" class="lab" text-anchor="middle">${esc(it.label)}</text>`;
  });
  return `${out}</svg>`;
}

/**
 * Line chart over visits. series: [{ name, color, values: [number|null] }], labels: [string]
 */
export function lineChart(labels, series, { height = 200 } = {}) {
  const W = Math.max(760, labels.length * 80 + 60), H = Math.max(height, 240), padL = 30, padB = 30, top = 12;
  const n = labels.length;
  const x = (i) => (n <= 1 ? (W + padL) / 2 : padL + 14 + (i * (W - padL - 28)) / (n - 1));
  const y = (v) => H - padB - (Math.max(0, Math.min(100, v)) / 100) * (H - padB - top);
  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">`;
  for (const g of [0, 25, 50, 75, 100]) {
    out += `<line x1="${padL}" x2="${W}" y1="${y(g)}" y2="${y(g)}" class="grid"/><text x="${padL - 5}" y="${y(g) + 3}" class="axis" text-anchor="end">${g}</text>`;
  }
  labels.forEach((l, i) => { out += `<text x="${x(i)}" y="${H - 10}" class="lab" text-anchor="middle">${esc(l)}</text>`; });
  for (const s of series) {
    const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)]));
    const d = pts.filter(Boolean).map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    out += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.5"/>`;
    pts.forEach((p, i) => {
      if (!p) return;
      out += `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="${s.color}"/>`;
      if (series.length === 1) out += `<text x="${p[0]}" y="${p[1] - 9}" class="val" text-anchor="middle">${Math.round(s.values[i])}</text>`;
    });
  }
  return `${out}</svg>`;
}
