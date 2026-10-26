'use strict';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 15;
const STRIP_N = 40;
const WINDOWS = [500, 1000, 2000, 5000, 10000, 20000, 50000];
const SPANS = [4, 6, 8, 12];
const DEFAULTS = {
  win: 2000,
  payout: 100,
  sound: true,
  targets: [1, 1.5, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000],
  focus: {
    focusA: { x: 100, notifyHit: false, droughtAt: 0 },
    focusB: { x: 1, notifyHit: false, droughtAt: 0 },
  },
  rowAlerts: {}, // target -> true: alert when Since reaches the row's % of Adj. gap
  rowPct: {}, // target -> custom alert %; rows without one use alertPct
  alertPct: 95,
  stratStake: 0.25, // strategy generator settings
  stratPeriod: 100,
  stratBudget: 20, // most a plan may lose
  stratGoal: 'balanced',
  onePay: null, // payout of a bet on an instant 1.00× crash (unknown until set)
  plan: null, // strategy being tracked
  devTargets: [1, 100, null, null], // fixed colour slots, so a series keeps its colour
  devMode: 'roll',
  chartMode: 'pan', // 'pan' | 'select'
  sel: null, // selected range on the Rounds chart: { from, to } round ids
  devRange: 5000,
  devSync: true, // Deviation chart shows the same rounds as the Rounds chart
  layout: null, // [[cardId, span], ...]
};

let S = loadSettings();
let games = []; // newest first: [id, rate, endTime|null]
let page = 1;
const byId = new Map();

// ---------- settings ----------

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('crash-settings-v2') || '{}'); } catch {}
  const d = structuredClone(DEFAULTS);
  return { ...d, ...s, focus: { focusA: { ...d.focus.focusA, ...s.focus?.focusA }, focusB: { ...d.focus.focusB, ...s.focus?.focusB } } };
}
function save() {
  try { localStorage.setItem('crash-settings-v2', JSON.stringify(S)); } catch {}
}

// ---------- math ----------

// Default chance per round: P(crash >= x) = 0.99 / x; an instant 1.00 crash is 2/101.
const prob = (x) => (x === 1 ? 2 / 101 : 0.99 / x);
const isHit = (rate, x) => (x === 1 ? rate < 1.01 : rate >= x);
const tname = (x) => (x === 1 ? '1.00×' : `${x}×`);
const tlabel = (x) => (x === 1 ? '= 1.00×' : `≥ ${x}×`);
const fmt = (r) => r.toFixed(2) + '×';
const pct = (v) => { const p = v * 100; return p === 0 ? '0%' : (p >= 1 ? p.toFixed(2) : p.toFixed(3)) + '%'; };
const gap = (n) => (n < 10 ? n.toFixed(1) : int(n));
const int = (n) => Math.round(n).toLocaleString();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// g = [id, rate, endTime, estimated]; estimated times (rounds older than the API's
// latest 100 that the server never saw live) are prefixed with ≈.
const clock = (g) => (g[2] ? (g[3] ? '≈ ' : '') + new Date(g[2]).toLocaleTimeString() : 'time n/a');
const win = () => Math.min(S.win, games.length);
const sample = () => games.slice(0, win());

// Hits, gaps and the current run for target x over a newest-first list.
function stats(list, x) {
  let hits = 0, first = -1, prev = -1, longest = 0;
  const gaps = []; // newest first
  for (let i = 0; i < list.length; i++) {
    if (!isHit(list[i][1], x)) continue;
    hits++;
    if (first < 0) first = i;
    else { const g = i - prev; gaps.push(g); if (g > longest) longest = g; }
    prev = i;
  }
  const since = first < 0 ? list.length : first;
  return { n: list.length, hits, since, found: first >= 0, last: first >= 0 ? list[first] : null, gaps, longest: Math.max(longest, since) };
}

// The average-gap model for one target.
function model(x) {
  const p = prob(x), avg = 1 / p;
  const all = stats(games, x);       // rounds since last hit uses all loaded history
  const w = stats(sample(), x);      // rates use the selected sample
  const rate = w.n ? w.hits / w.n : 0;
  const expHits = w.n * p;
  const z = expHits ? (w.hits - expHits) / Math.sqrt(expHits * (1 - p)) : 0;
  // Observed rate above default -> gap between hits stretches; below -> it shrinks.
  const adjGap = avg * clamp(rate / p, 0.25, 4);
  const k = all.since;
  const due = 1 - (1 - p) ** k;           // chance a hit would have come within k rounds
  const nextIn = adjGap - k;
  // > 0: rounds without a hit for the sample rate to fall back to default; < 0: hits behind default
  const balance = rate > p ? w.hits / p - w.n : w.hits - expHits;
  const obsGap = w.gaps.length ? w.gaps.reduce((a, b) => a + b, 0) / w.gaps.length : null;
  return { x, p, avg, all, w, rate, expHits, z, adjGap, k, due, nextIn, balance, obsGap };
}

function phase(m) {
  const r = m.k / m.adjGap;
  if (r < 0.5) return { label: 'Early', color: 'text-muted' };
  if (r < 1) return { label: 'Building', color: 'series-lo' };
  if (r < 2) return { label: 'Due', color: 'warn' };
  return { label: 'Overdue', color: 'series-hi' };
}

const pillClass = (r) => (r < 1.01 ? 'one' : r >= S.payout ? 'hi' : '');
const pill = (r, extra = '') => `<span class="pill ${pillClass(r)} ${extra}">${fmt(r)}</span>`;
const sigma = (z) => `<span class="${Math.abs(z) < 2 ? 'dim' : z > 0 ? 'pos' : 'neg'}">${z >= 0 ? '+' : ''}${z.toFixed(1)}σ</span>`;

// ---------- header, strip, overview ----------

function renderHeader(flash) {
  const g = games[0];
  $('latestId').textContent = '#' + g[0];
  const el = $('latestRate');
  el.textContent = fmt(g[1]);
  el.className = `pill big ${pillClass(g[1])}`;
  if (flash) { void el.offsetWidth; el.classList.add('flash'); }
  $('strip').innerHTML = games.slice(0, STRIP_N).map((g) => `<span data-g="${g[0]}">${pill(g[1])}</span>`).join('');

  const sel = $('winSel');
  const opts = WINDOWS.filter((n) => n < games.length).concat(games.length);
  const html = opts.map((n) => `<option value="${n}">${n === games.length ? `All (${int(n)})` : `Last ${int(n)}`}</option>`).join('');
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  sel.value = opts.includes(S.win) ? S.win : (S.win >= games.length ? games.length : opts[0]);
  $('soundBtn').setAttribute('aria-pressed', S.sound);
}

// Crash-point buckets for the overview distribution bar; expected share = P(≥a) − P(≥b).
const BUCKETS = [
  { label: '1.00×', test: (r) => r < 1.01, exp: 2 / 101, color: 'var(--series-one)' },
  { label: '1.01–2×', test: (r) => r >= 1.01 && r < 2, exp: 0.99 / 1.01 - 0.99 / 2, color: 'var(--ramp-1)' },
  { label: '2–10×', test: (r) => r >= 2 && r < 10, exp: 0.99 / 2 - 0.99 / 10, color: 'var(--ramp-2)' },
  { label: '10–100×', test: (r) => r >= 10 && r < 100, exp: 0.99 / 10 - 0.99 / 100, color: 'var(--ramp-3)' },
  { label: '100×+', test: (r) => r >= 100, exp: 0.99 / 100, color: 'var(--ramp-4)' },
];

function renderOverview() {
  const s = sample();
  const rates = s.map((g) => g[1]).sort((a, b) => a - b);
  const top = s.reduce((m, g) => (g[1] > m[1] ? g : m), s[0]);
  const one = rates.filter((r) => r < 1.01).length / s.length;
  const shares = BUCKETS.map((b) => ({ ...b, obs: rates.filter(b.test).length / s.length }));
  const kpi = (label, value, sub, tip = '') =>
    `<div class="kpi" ${tip ? `data-tip="${tip}"` : ''}><span class="label">${label}</span><b>${value}</b><span class="sub">${sub}</span></div>`;

  $('tiles').innerHTML = `
    <div class="kpis">
      ${kpi('Median', fmt(rates[Math.floor(rates.length / 2)]), `${pct(rates.filter((r) => r < 2).length / s.length)} under 2×`)}
      ${kpi('Highest', fmt(top[1]), `#${top[0]}`)}
      ${kpi('Instant 1.00×', pct(one), `default ${pct(prob(1))}`)}
    </div>
    <div class="dist" role="img" aria-label="Distribution of crash points in the sample">
      ${shares.map((b) => `<i style="flex-grow:${Math.max(b.obs, 0.002)}; background:${b.color}"
        data-tip="<b>${b.label}</b><br>${pct(b.obs)} of the sample · expected ${pct(b.exp)}"></i>`).join('')}
    </div>
    <div class="dist-legend">
      ${shares.map((b) => `<span data-tip="Expected ${pct(b.exp)}"><i style="background:${b.color}"></i>${b.label} <b>${pct(b.obs)}</b></span>`).join('')}
    </div>
    <div class="ov-foot">
      <span>${int(games.length)} rounds loaded</span>
      <span>Sample #${s.at(-1)[0]} – #${s[0][0]}</span>
      <span>Last round ${clock(games[0])}</span>
    </div>`;
  $('csvLink').href = `/api/history.csv?limit=${win()}`;
}

// ---------- focus trackers ----------

function targetOptions(selected) {
  const xs = [...new Set([...S.targets, selected])].sort((a, b) => a - b);
  return xs.map((x) => `<option value="${x}" ${x === selected ? 'selected' : ''}>${tlabel(x)}</option>`).join('');
}

// Ring gauge for the Due %.
function gauge(due, color) {
  const r = 50, c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 120 120" aria-hidden="true">
    <circle class="g-track" cx="60" cy="60" r="${r}"/>
    <circle class="g-arc" cx="60" cy="60" r="${r}" style="stroke:var(--${color})"
      stroke-dasharray="${(c * due).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 60 60)"/></svg>`;
}

function renderFocus(card) {
  const cfg = S.focus[card.dataset.card];
  const m = model(cfg.x);
  const ph = phase(m);
  card.querySelector('h2').textContent = `${tname(cfg.x)} tracker`;
  const sel = card.querySelector('.focus-target');
  const opts = targetOptions(cfg.x);
  if (sel.dataset.html !== opts) { sel.innerHTML = opts; sel.dataset.html = opts; }
  sel.value = cfg.x;
  card.querySelector('.bell').setAttribute('aria-pressed', cfg.notifyHit);

  const maxV = Math.max(Math.max(m.adjGap, m.avg) * 2.2, m.k * 1.05);
  const pos = (v) => clamp((v / maxV) * 100, 0, 100);
  const gaps = m.all.gaps.slice(0, 24).reverse();
  const last = m.all.last;
  const next = m.nextIn > 0 ? `next in ~${gap(m.nextIn)}` : `overdue by ${gap(-m.nextIn)}`;
  const dueTip = `Due: chance a hit would have arrived within ${int(m.k)} rounds = 1 − (1 − ${pct(m.p)})^${int(m.k)}.<br>`
    + `After +10 / +50 / +100 more rounds: ${[10, 50, 100].map((n) => pct(1 - (1 - m.p) ** (m.k + n))).join(' / ')}`;
  const modelTip = `Default ${pct(m.p)} (1 in ${gap(m.avg)}) · observed ${pct(m.rate)} in the sample (${m.w.hits} hits vs ${m.expHits.toFixed(1)} expected, ${m.z >= 0 ? '+' : ''}${m.z.toFixed(1)}σ).<br>`
    + `Adjusted gap = ${gap(m.avg)} × ${(m.adjGap / m.avg).toFixed(2)} = ${gap(m.adjGap)} · observed average gap ${m.obsGap ? int(m.obsGap) : '—'} · longest ${int(m.w.longest)}.<br>`
    + (m.balance > 0 ? `${int(m.balance)} rounds without a hit would bring the sample back to the default rate.` : `${(-m.balance).toFixed(1)} hits behind the default pace.`);

  card.querySelector('.focus-body').innerHTML = `
    <div class="trk">
      <div class="gauge" data-tip="${dueTip}">
        ${gauge(m.due, ph.color)}
        <div class="g-center"><b>${pct(m.due).replace(/(\.\d)\d+%/, '$1%')}</b><span>due</span></div>
      </div>
      <div class="trk-main">
        <div class="label">Rounds since last ${tname(cfg.x)}</div>
        <div class="hero">${m.all.found ? int(m.k) : '&gt;' + int(m.k)}
          <span class="phase" style="--c: var(--${ph.color})">${ph.label}</span></div>
        <div class="sub">${last ? `Last ${fmt(last[1])} · #${last[0]} · ${clock(last)}` : 'Not seen in loaded history'}</div>
        <div class="facts" data-tip="${modelTip}">
          <span>${pct(m.p)} per round</span><span>adj. gap ${gap(m.adjGap)}</span><span class="${m.nextIn > 0 ? '' : 'over'}">${next}</span>
        </div>
      </div>
    </div>
    <div class="progress" data-tip="Rounds since the last hit (${int(m.k)}) against the average gap (${gap(m.avg)}) and your adjusted gap (${gap(m.adjGap)})">
      <div class="fill" style="width:${pos(m.k)}%; background: var(--${ph.color})"></div>
      <div class="mark" style="left:${pos(m.avg)}%"><span>avg ${int(m.avg)}</span></div>
      <div class="mark adj" style="left:${pos(m.adjGap)}%"><span>adj ${int(m.adjGap)}</span></div>
    </div>
    <div class="spark-title"><span class="label">Last ${gaps.length} gaps</span><span class="label">orange = longer than average</span></div>
    <div class="spark">${spark(gaps, m.avg)}</div>
    <label class="alert-row">Alert when gap reaches
      <input class="drought" type="number" min="0" step="1" value="${cfg.droughtAt || ''}" placeholder="off"> rounds</label>`;
}

function spark(gaps, avg) {
  if (!gaps.length) return '<div class="sub">No completed gaps yet.</div>';
  const W = 400, H = 56, max = Math.max(avg * 1.2, ...gaps), step = W / gaps.length, bw = Math.max(2, step - 3);
  const y = (v) => H - (v / max) * (H - 4);
  return `<svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${gaps.map((g, i) => `<rect class="${g > avg ? 'long' : ''}" x="${i * step + 1}" y="${y(g)}" width="${bw}" height="${H - y(g)}" rx="1.5"
      data-tip="Gap of ${int(g)} rounds"/>`).join('')}
    <line x1="0" x2="${W}" y1="${y(avg)}" y2="${y(avg)}" vector-effect="non-scaling-stroke"/></svg>`;
}

// ---------- probability board ----------

const rowPctOf = (x) => S.rowPct[x] ?? S.alertPct;

function renderProbs() {
  if (document.activeElement?.matches('.row-pct')) return; // don't wipe a threshold being typed
  const focusXs = [S.focus.focusA.x, S.focus.focusB.x];
  $('probBody').innerHTML = [...S.targets].sort((a, b) => a - b).map((x) => {
    const m = model(x), ph = phase(m);
    const next = m.nextIn > 0 ? `~${gap(m.nextIn)}` : `<span class="neg">+${gap(-m.nextIn)}</span>`;
    const pctX = rowPctOf(x), custom = S.rowPct[x] != null;
    const on = !!S.rowAlerts[x], at = (m.adjGap * pctX) / 100;
    return `<tr class="${focusXs.includes(x) ? 'focus' : ''} ${on && m.k >= at ? 'armed' : ''}">
      <td>${tlabel(x)}</td>
      <td>${pct(m.p)}</td>
      <td>${gap(m.avg)}</td>
      <td>${m.w.hits} <span class="dim">/ ${m.expHits.toFixed(1)}</span></td>
      <td>${pct(m.rate)}</td>
      <td>${sigma(m.z)}</td>
      <td>${gap(m.adjGap)}</td>
      <td>${m.all.found ? int(m.k) : '&gt;' + int(m.k)}</td>
      <td style="text-align:left">${pct(m.due)}<span class="meter"><i style="width:${m.due * 100}%; background: var(--${ph.color})"></i></span></td>
      <td>${next}</td>
      <td style="color: var(--${ph.color})">${ph.label}</td>
      <td>${int(m.w.longest)}</td>
      <td class="alert-cell"><span class="row-pct-wrap ${custom ? 'custom' : ''}"
          data-tip="Alert threshold for this row: ${pctX}% of Adj. gap = ${gap(at)} rounds.${custom ? '' : ' Using the default — type a value to override, clear it to go back to the default.'}">
          <input class="row-pct" type="number" min="1" max="500" step="1" data-x="${x}" value="${custom ? pctX : ''}" placeholder="${S.alertPct}" aria-label="Alert % for ${tlabel(x)}">%</span>
        <button class="icon-btn bell row-bell" aria-pressed="${on}" data-x="${x}"
          data-tip="Alert ${on ? 'on' : 'off'}: notify when Since reaches ${pctX}% of Adj. gap (${gap(at)} rounds)">🔔</button></td>
      <td><button class="del" data-x="${x}" data-tip="Remove target">×</button></td>
    </tr>`;
  }).join('');
}

// ---------- classic analysis panel ----------

function runs(flags) {
  let max = 0, run = 0;
  for (const f of flags) { run = f ? run + 1 : 0; if (run > max) max = run; }
  let now = 0;
  while (now < flags.length && flags[now]) now++;
  return { max, now };
}

function renderAnalysis() {
  const s = sample(), x = S.payout, xs = String(+x.toFixed(2));
  const hi = s.map((g) => g[1] >= x);
  const nHi = hi.filter(Boolean).length;
  const rLo = runs(hi.map((h) => !h)), rHi = runs(hi);
  const row = (label, count, r) =>
    `<tr><td>${label}</td><td>${pct(count / s.length)}</td><td>${count}</td><td>${r.max}</td><td>${r.now}</td></tr>`;
  $('rangeBody').innerHTML = row(`[1, ${xs})`, s.length - nHi, rLo) + row(`[${xs}, ∞)`, nHi, rHi);
  $('colLo').textContent = `[1, ${xs})`;
  $('colHi').textContent = `[${xs}, ∞)`;
  $('legLo').textContent = `< ${xs}×`;
  $('legHi').textContent = `≥ ${xs}×`;
  if (document.activeElement !== $('inX')) $('inX').value = x;

  const pages = Math.max(1, Math.ceil(s.length / PAGE_SIZE));
  page = clamp(page, 1, pages);
  $('pageCount').textContent = int(pages);
  if (document.activeElement !== $('pageIn')) $('pageIn').value = page;
  $('prev').disabled = page <= 1;
  $('next').disabled = page >= pages;

  const rows = s.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const box = $('beads');
  box.innerHTML = rows.map((g) => {
    const up = g[1] >= x;
    return `<div class="bead-row" data-g="${g[0]}"><span class="id mono">${g[0]}</span>
      <span>${up ? '' : pill(g[1])}</span><span>${up ? pill(g[1]) : ''}</span></div>`;
  }).join('');
  const w = box.clientWidth, rowH = 30, idW = 80, colW = (w - idW) / 2;
  const pts = rows.map((g, i) => `${idW + colW * (g[1] >= x ? 1.5 : 0.5)},${i * rowH + rowH / 2}`).join(' ');
  box.insertAdjacentHTML('afterbegin',
    `<svg class="link" width="${w}" height="${rows.length * rowH}"><polyline points="${pts}" fill="none" stroke="#2fb36f" stroke-width="2"/></svg>`);
}

// ---------- main chart (canvas, drag to pan, wheel to zoom) ----------

const view = { offset: 0, count: 150, hover: -1 };
let geom = null;
let drag = null;
let selDrag = null; // range being drawn on the chart

function renderChart() {
  const wrap = $('chart'), cv = $('chartCanvas');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !games.length) return;
  const dpr = devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const total = games.length;
  view.count = clamp(Math.round(view.count), 20, Math.min(3000, total));
  view.offset = clamp(Math.round(view.offset), 0, total - view.count);
  const data = games.slice(view.offset, view.offset + view.count).reverse(); // oldest -> newest

  const css = getComputedStyle(document.documentElement);
  const c = (n) => css.getPropertyValue(n).trim();
  const m = { l: 46, r: 12, t: 14, b: 24 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b, base = m.t + ih;
  let maxV = 10;
  for (const g of data) if (g[1] > maxV) maxV = g[1];
  const top = Math.min(10 ** Math.ceil(Math.log10(maxV)), 1e6);
  const y = (v) => base - (Math.log10(clamp(v, 1, top)) / Math.log10(top)) * ih;

  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const t of [1, 2, 5, 10, 100, 1e3, 1e4, 1e5, 1e6].filter((t) => t <= top)) {
    ctx.strokeStyle = c('--grid'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(m.l, Math.round(y(t)) + 0.5); ctx.lineTo(W - m.r, Math.round(y(t)) + 0.5); ctx.stroke();
    ctx.fillStyle = c('--text-muted');
    ctx.fillText(t >= 1000 ? `${t / 1000}k×` : `${t}×`, m.l - 8, y(t));
  }

  const step = iw / view.count;
  const pad = step > 5 ? 2 : step > 2.5 ? 1 : 0;
  const bw = Math.max(1, step - pad);
  const col = { lo: c('--series-lo'), hi: c('--series-hi'), one: c('--series-one') };

  // Selected range: shaded band behind the bars; bars outside it are dimmed.
  let band = null;
  if (S.sel) {
    const i0 = data.findIndex((g) => g[0] >= S.sel.from), i1 = data.findLastIndex((g) => g[0] <= S.sel.to);
    if (i0 >= 0 && i1 >= i0) {
      band = { i0, i1, x0: m.l + i0 * step, x1: m.l + (i1 + 1) * step };
      ctx.fillStyle = c('--sel-fill');
      ctx.fillRect(band.x0, m.t, band.x1 - band.x0, ih);
      ctx.strokeStyle = c('--sel-edge'); ctx.lineWidth = 1;
      for (const x of [band.x0, band.x1]) { ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, m.t); ctx.lineTo(Math.round(x) + 0.5, base); ctx.stroke(); }
    }
  }

  data.forEach((g, i) => {
    const x0 = m.l + i * step + pad / 2;
    const yv = y(g[1]), h = Math.max(2, base - yv);
    ctx.fillStyle = g[1] < 1.01 ? col.one : g[1] >= S.payout ? col.hi : col.lo;
    const outside = S.sel && !(g[0] >= S.sel.from && g[0] <= S.sel.to);
    ctx.globalAlpha = outside ? 0.35 : view.hover < 0 || view.hover === i ? 1 : 0.75;
    if (bw >= 4 && ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x0, base - h, bw, h, [Math.min(3, bw / 2), Math.min(3, bw / 2), 0, 0]); ctx.fill(); }
    else ctx.fillRect(x0, base - h, bw, h);
    if (g[1] < 1.01 && bw >= 2) { ctx.beginPath(); ctx.arc(x0 + bw / 2, base + 6, Math.min(3, bw / 2 + 0.5), 0, Math.PI * 2); ctx.fill(); }
  });
  ctx.globalAlpha = 1;

  if (view.hover >= 0 && view.hover < data.length) {
    const hx = m.l + view.hover * step + step / 2;
    ctx.strokeStyle = c('--text-muted'); ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(hx, m.t); ctx.lineTo(hx, base); ctx.stroke(); ctx.setLineDash([]);
  }

  if (S.payout <= top) {
    const ty = Math.round(y(S.payout)) + 0.5;
    ctx.strokeStyle = c('--text-secondary'); ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(m.l, ty); ctx.lineTo(W - m.r, ty); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = c('--text-secondary'); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText(`${+S.payout.toFixed(2)}×`, W - m.r - 2, ty - 3);
  }

  if (band) {
    const n = S.sel.to - S.sel.from + 1;
    const label = `${int(n)} round${n === 1 ? '' : 's'}`;
    ctx.font = '600 11px system-ui, sans-serif';
    const tw = ctx.measureText(label).width + 12;
    const lx = clamp((band.x0 + band.x1) / 2 - tw / 2, m.l, W - m.r - tw);
    ctx.fillStyle = c('--surface-2'); ctx.fillRect(lx, m.t, tw, 17);
    ctx.fillStyle = c('--text-primary'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + 6, m.t + 9);
    ctx.font = '11px system-ui, sans-serif';
  }

  ctx.fillStyle = c('--text-muted'); ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left'; ctx.fillText(`#${data[0][0]}`, m.l, H - 2);
  ctx.textAlign = 'right'; ctx.fillText(`#${data.at(-1)[0]}`, W - m.r, H - 2);

  geom = { m, step, data };
  $('chart').classList.toggle('selecting', S.chartMode === 'select');
  $('modePan').setAttribute('aria-pressed', S.chartMode !== 'select');
  $('modeSelect').setAttribute('aria-pressed', S.chartMode === 'select');
  $('chartRangeLabel').textContent = `#${data[0][0]} – #${data.at(-1)[0]} (${data.length})`;
  const live = view.offset === 0;
  $('liveBadge').textContent = live ? 'LIVE' : `${int(view.offset)} rounds back`;
  $('liveBadge').classList.toggle('off', !live);
  const sc = $('chartScroll');
  sc.max = total - view.count;
  sc.value = total - view.count - view.offset;
}

// Both round-aligned charts (Rounds, and Deviation when synced) redraw together.
function renderCharts() {
  renderChart();
  renderDev();
}

// Select mode, or Shift held in pan mode, draws a range instead of panning.
const selecting = (e) => (S.chartMode === 'select') !== e.shiftKey;

// Index of the round under the pointer for a chart with geometry g = { m, step, data }.
function roundIndex(e, el, g, clampToEdges = false) {
  const r = el.getBoundingClientRect();
  const i = Math.floor((e.clientX - r.left - g.m.l) / g.step);
  if (clampToEdges) return clamp(i, 0, g.data.length - 1);
  return i >= 0 && i < g.data.length ? i : -1;
}

// Drag to pan (or select), wheel to zoom, double-click for live, hover crosshair + tooltip.
// All of it drives the shared `view`, so every round-aligned chart follows.
// interactive(): whether pan/zoom/select apply; hoverOf(): object whose .hover is set.
function bindRoundsPointer(el, geomOf, tipOf, interactive = () => true, hoverOf = () => view) {
  el.addEventListener('pointerdown', (e) => {
    const g = geomOf();
    if (!g || e.button !== 0 || !interactive()) return;
    el.setPointerCapture(e.pointerId);
    hideTip();
    if (selecting(e)) {
      selDrag = { el, anchor: g.data[roundIndex(e, el, g, true)][0], x: e.clientX, moved: false };
      return;
    }
    drag = { el, x: e.clientX, off: view.offset };
    el.classList.add('grabbing');
  });
  el.addEventListener('pointermove', (e) => {
    const g = geomOf();
    if (!g) return;
    if (selDrag?.el === el) {
      if (Math.abs(e.clientX - selDrag.x) > 3) selDrag.moved = true;
      if (!selDrag.moved) return;
      const id = g.data[roundIndex(e, el, g, true)][0];
      S.sel = { from: Math.min(selDrag.anchor, id), to: Math.max(selDrag.anchor, id) };
      renderCharts();
      renderDensity();
      return;
    }
    if (drag?.el === el) {
      view.offset = drag.off + Math.round((e.clientX - drag.x) / g.step);
      view.hover = -1;
      renderCharts();
      return;
    }
    if (drag || selDrag) return;
    const i = roundIndex(e, el, g), h = hoverOf();
    if (i !== h.hover) { h.hover = i; renderCharts(); }
    if (i >= 0) showTip(tipOf(i, g), e); else hideTip();
  });
  const end = () => {
    if (selDrag?.el === el) {
      if (!selDrag.moved) S.sel = null; // a plain click clears the selection
      selDrag = null;
      save();
      render();
    }
    if (drag?.el === el) drag = null;
    el.classList.remove('grabbing');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', () => {
    if (drag || selDrag) return;
    hoverOf().hover = -1;
    renderCharts();
    hideTip();
  });
  el.addEventListener('wheel', (e) => {
    const g = geomOf();
    if (!g || !interactive()) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const f = clamp((e.clientX - r.left - g.m.l) / (r.width - g.m.l - g.m.r), 0, 1);
    const anchor = view.offset + (1 - f) * view.count; // rounds-from-newest under the cursor
    view.count = clamp(view.count * (e.deltaY > 0 ? 1.2 : 1 / 1.2), 20, Math.min(3000, games.length));
    view.offset = anchor - (1 - f) * view.count;
    renderCharts();
  }, { passive: false });
  el.addEventListener('dblclick', () => { if (interactive()) { view.offset = 0; view.count = 150; renderCharts(); } });
}

function initChart() {
  // Rounds tooltip also lists the deviation lines at that round while the charts are synced.
  bindRoundsPointer($('chart'), () => geom,
    (i, g) => gameTip(g.data[i]) + (S.devSync && devGeom?.series.length ? `<br>${devTipRows(i)}` : ''));
  $('chartScroll').addEventListener('input', (e) => { view.offset = +e.target.max - +e.target.value; renderCharts(); });
  $('zoomIn').onclick = () => { view.count /= 1.5; renderCharts(); };
  $('zoomOut').onclick = () => { view.count *= 1.5; renderCharts(); };
  $('goLive').onclick = $('liveBadge').onclick = () => { view.offset = 0; renderCharts(); };
  $('modePan').onclick = () => { S.chartMode = 'pan'; save(); renderCharts(); };
  $('modeSelect').onclick = () => { S.chartMode = 'select'; save(); renderCharts(); };

  // Range inputs and buttons in the density panel
  const setRange = (a, b) => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    S.sel = { from: Math.min(a, b), to: Math.max(a, b) };
    save(); render();
  };
  for (const id of ['selFrom', 'selTo']) {
    $(id).addEventListener('change', () => setRange(Math.round(+$('selFrom').value), Math.round(+$('selTo').value)));
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  }
  $('selVisible').onclick = () => geom && setRange(geom.data[0][0], geom.data.at(-1)[0]);
  $('selLast').onclick = () => games.length && setRange(games[0][0] - Math.min(win(), games.length) + 1, games[0][0]);
  $('selClear').onclick = () => { S.sel = null; save(); render(); };
}

// ---------- density of the selected range ----------

// Rounds of the selected range (newest first), clipped to the loaded history.
function selRounds() {
  if (!S.sel || !games.length) return null;
  const top = games[0][0], low = games.at(-1)[0];
  const from = Math.max(S.sel.from, low), to = Math.min(S.sel.to, top);
  return from > to ? [] : games.slice(top - to, top - from + 1);
}

function renderDensity() {
  const rows = selRounds();
  const has = !!rows?.length;
  $('densityBody').hidden = !has;
  $('selClear').disabled = !S.sel;
  for (const [id, v] of [['selFrom', S.sel?.from], ['selTo', S.sel?.to]]) {
    if (document.activeElement !== $(id)) $(id).value = v ?? '';
  }
  if (!S.sel) {
    $('densitySummary').innerHTML = `Drag across the chart in <b>Select</b> mode (or hold <b>Shift</b> while dragging) to pick a range,
      or type round numbers. A plain click on the chart clears the selection.`;
    return;
  }
  if (!has) { $('densitySummary').textContent = 'The selected rounds are outside the loaded history.'; return; }

  const n = rows.length, newest = rows[0], oldest = rows.at(-1);
  const mins = newest[2] && oldest[2] ? (newest[2] - oldest[2]) / 60000 : null;
  const span = mins == null ? '' : mins < 90 ? `${Math.round(mins)} min` : `${(mins / 60).toFixed(1)} h`;
  const est = newest[3] || oldest[3] ? '≈ ' : '';
  $('densitySummary').innerHTML = `<b>${int(n)}</b> rounds · #${oldest[0]} – #${newest[0]}` +
    (span ? ` · ${est}${new Date(oldest[2]).toLocaleString()} → ${new Date(newest[2]).toLocaleTimeString()} (${est}${span})` : '');

  const focusXs = [S.focus.focusA.x, S.focus.focusB.x];
  $('densityRows').innerHTML = [...S.targets].sort((a, b) => a - b).map((x) => {
    const p = prob(x);
    let hits = 0;
    for (const g of rows) if (isHit(g[1], x)) hits++;
    const obs = hits / n, expHits = n * p;
    const z = (hits - expHits) / Math.sqrt(expHits * (1 - p));
    const diff = (obs - p) * 100;
    const scale = Math.max(obs, p) * 1.25 || 1;
    const cls = [focusXs.includes(x) ? 'focus' : '', x === S.payout ? 'thr' : ''].join(' ');
    return `<tr class="${cls}">
      <td>${tlabel(x)}</td>
      <td>${hits} <span class="dim">/ ${expHits.toFixed(1)}</span></td>
      <td><b>${pct(obs)}</b></td>
      <td>${pct(p)}</td>
      <td class="${Math.abs(z) < 2 ? 'dim' : diff > 0 ? 'pos' : 'neg'}">${diff >= 0 ? '+' : ''}${diff.toFixed(diff && Math.abs(diff) < 1 ? 3 : 2)} pp</td>
      <td>${hits ? '×' + (obs / p).toFixed(2) : '×0'}</td>
      <td>${sigma(z)}</td>
      <td><span class="dmeter" data-tip="Bar = observed density ${pct(obs)} · line = expected ${pct(p)}">
        <i style="width:${(obs / scale) * 100}%"></i><b style="left:${(p / scale) * 100}%"></b></span></td>
    </tr>`;
  }).join('');
}

// ---------- deviation chart ----------

const DEV_COLORS = ['--cat-1', '--cat-2', '--cat-3', '--cat-4'];
const dev = { hover: -1 }; // hover index when not synced (synced charts share view.hover)
let devGeom = null;
let devCache = { key: '', series: null };

// z-score series for one target. `seg` is oldest-first; the plotted points are its
// last `span` rounds, the rounds before them only feed the rolling window.
// roll: window of `w` rounds ending at each point (NaN until a full window exists);
// cum: everything since the first plotted round.
function devSeries(seg, x, mode, w, span) {
  const p = prob(x), vals = new Float64Array(span).fill(NaN), lead = seg.length - span;
  const hit = (i) => (isHit(seg[i][1], x) ? 1 : 0);
  if (mode === 'roll') {
    const sd = Math.sqrt(w * p * (1 - p));
    let c = 0;
    for (let i = 0; i < seg.length; i++) {
      c += hit(i);
      if (i >= w) c -= hit(i - w);
      const j = i - lead;
      if (j >= 0 && i >= w - 1) vals[j] = (c - w * p) / sd;
    }
  } else {
    let c = 0;
    for (let j = 0; j < span; j++) {
      c += hit(lead + j);
      const n = j + 1;
      vals[j] = (c - n * p) / Math.sqrt(n * p * (1 - p));
    }
  }
  return vals;
}

// σ values at plotted index j, for tooltips on either chart.
function devTipRows(j) {
  if (!devGeom) return '';
  return devGeom.series.map((s) => {
    const v = s.vals[j];
    return `<span style="color:var(${DEV_COLORS[s.slot]})">●</span> ${tlabel(s.x)} &nbsp;<b>${Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}σ`}</b>`;
  }).join('<br>');
}

function renderDev() {
  const wrap = $('devChart'), cv = $('devCanvas');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  $('devMode').value = S.devMode;
  $('devSync').setAttribute('aria-pressed', S.devSync);
  $('devRange').hidden = S.devSync; // the Rounds chart decides the range while synced
  wrap.classList.toggle('synced', S.devSync);
  wrap.classList.toggle('selecting', S.devSync && S.chartMode === 'select');

  // Target chips: colour comes from the target's fixed slot.
  const css = getComputedStyle(document.documentElement);
  const c = (n) => css.getPropertyValue(n).trim();
  const chips = [...S.targets].sort((a, b) => a - b).map((x) => {
    const slot = S.devTargets.indexOf(x);
    return `<button class="chip" data-x="${x}" aria-pressed="${slot >= 0}">
      <i class="sw" style="background:${slot >= 0 ? `var(${DEV_COLORS[slot]})` : 'transparent'}"></i>${tlabel(x)}</button>`;
  }).join('');
  if ($('devChips').dataset.html !== chips) { $('devChips').innerHTML = chips; $('devChips').dataset.html = chips; }
  if (!W || !games.length) return;

  const w = win(), mode = S.devMode, lead = mode === 'roll' ? w - 1 : 0;
  let offset, span;
  if (S.devSync) {
    // Exactly the rounds on the Rounds chart (renderChart has already clamped view).
    offset = view.offset;
    span = Math.min(view.count, games.length - offset);
    $('devHint').textContent = Math.abs($('chart').clientWidth - W) > 2
      ? 'Give this panel the same width as the Rounds chart (⇔) so the rounds line up exactly.'
      : 'Synced with the Rounds chart: same rounds, same positions. Drag, zoom, select and hover work on both.';
  } else {
    const maxSpan = games.length - lead;
    const ranges = [2000, 5000, 10000, 20000].filter((n) => n < maxSpan).concat(maxSpan);
    const rsel = $('devRange');
    const rhtml = ranges.map((n) => `<option value="${n}">${n === maxSpan ? `All (${int(n)})` : `Last ${int(n)}`}</option>`).join('');
    if (rsel.dataset.html !== rhtml) { rsel.innerHTML = rhtml; rsel.dataset.html = rhtml; }
    offset = 0;
    span = Math.min(S.devRange, maxSpan);
    rsel.value = ranges.includes(span) ? span : maxSpan;
    $('devHint').textContent = 'Not synced: showing its own range. Turn on 🔗 Sync to line it up with the Rounds chart.';
  }

  const dpr = devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.font = '11px system-ui, sans-serif';
  if (span < 2) {
    ctx.fillStyle = c('--text-muted'); ctx.textAlign = 'center';
    ctx.fillText('Not enough rounds for this sample size — choose a smaller Sample in the header.', W / 2, H / 2);
    devGeom = null;
    return;
  }

  const seg = games.slice(offset, offset + span + lead).reverse(); // oldest -> newest
  const data = seg.slice(seg.length - span);                       // the plotted rounds
  // Hovering redraws often; only recompute the series when the inputs change.
  const key = [games[0][0], games.length, offset, span, w, mode, S.devTargets.join(',')].join('|');
  if (devCache.key !== key) {
    devCache = { key, series: S.devTargets.map((x, slot) => (x == null ? null : { x, slot, vals: devSeries(seg, x, mode, w, span) })).filter(Boolean) };
  }
  const series = devCache.series;

  const m = { l: 46, r: 12, t: 12, b: 24 }; // same side margins as the Rounds chart
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const step = iw / span;
  const xAt = (j) => m.l + j * step + step / 2; // centre of the matching bar
  let lim = 3;
  for (const s of series) for (const v of s.vals) if (Math.abs(v) > lim) lim = Math.abs(v);
  lim = Math.ceil(lim);
  const y = (v) => m.t + ih / 2 - (v / lim) * (ih / 2);

  // Selected range (synced): same band as on the Rounds chart.
  if (S.devSync && S.sel) {
    const i0 = data.findIndex((g) => g[0] >= S.sel.from), i1 = data.findLastIndex((g) => g[0] <= S.sel.to);
    if (i0 >= 0 && i1 >= i0) {
      const x0 = m.l + i0 * step, x1 = m.l + (i1 + 1) * step;
      ctx.fillStyle = c('--sel-fill'); ctx.fillRect(x0, m.t, x1 - x0, ih);
      ctx.strokeStyle = c('--sel-edge'); ctx.lineWidth = 1;
      for (const x of [x0, x1]) { ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, m.t); ctx.lineTo(Math.round(x) + 0.5, m.t + ih); ctx.stroke(); }
    }
  }

  // ±1σ and ±2σ bands = ordinary noise
  ctx.fillStyle = '#ffffff08'; ctx.fillRect(m.l, y(2), iw, y(-2) - y(2));
  ctx.fillStyle = '#ffffff08'; ctx.fillRect(m.l, y(1), iw, y(-1) - y(1));
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const tick = lim > 6 ? 2 : 1;
  for (let t = -lim; t <= lim; t += tick) {
    ctx.strokeStyle = t === 0 ? c('--text-muted') : c('--grid');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(m.l, Math.round(y(t)) + 0.5); ctx.lineTo(W - m.r, Math.round(y(t)) + 0.5); ctx.stroke();
    ctx.fillStyle = c('--text-muted');
    ctx.fillText(`${t > 0 ? '+' : ''}${t}σ`, m.l - 8, y(t));
  }

  // Lines, thinned to about one point per pixel; gaps where there is no full window yet.
  const stride = Math.max(1, Math.floor(span / iw));
  ctx.lineWidth = 2; ctx.lineJoin = 'round';
  for (const s of series) {
    ctx.strokeStyle = c(DEV_COLORS[s.slot]);
    ctx.beginPath();
    let pen = false;
    const point = (j) => {
      const v = s.vals[j];
      if (Number.isNaN(v)) { pen = false; return; }
      (pen ? ctx.lineTo : ctx.moveTo).call(ctx, xAt(j), y(v));
      pen = true;
    };
    for (let j = 0; j < span; j += stride) point(j);
    if ((span - 1) % stride) point(span - 1); // always end on the newest round
    ctx.stroke();
  }

  const hover = S.devSync ? view.hover : dev.hover;
  if (hover >= 0 && hover < span) {
    const hx = xAt(hover);
    ctx.strokeStyle = c('--text-muted'); ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(hx, m.t); ctx.lineTo(hx, m.t + ih); ctx.stroke(); ctx.setLineDash([]);
    for (const s of series) {
      if (Number.isNaN(s.vals[hover])) continue;
      ctx.fillStyle = c(DEV_COLORS[s.slot]); ctx.strokeStyle = c('--surface-1'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hx, y(s.vals[hover]), 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  ctx.fillStyle = c('--text-muted'); ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left'; ctx.fillText(`#${data[0][0]}`, m.l, H - 2);
  ctx.textAlign = 'right'; ctx.fillText(`#${data.at(-1)[0]}`, W - m.r, H - 2);

  devGeom = { m, step, data, series };
}

function initDev() {
  // Synced: the same drag / wheel / select / hover handling as the Rounds chart.
  // Not synced: hover only.
  bindRoundsPointer($('devChart'), () => devGeom, (i, g) => `<b>#${g.data[i][0]}</b> ${fmt(g.data[i][1])}<br>${devTipRows(i)}`,
    () => S.devSync, () => (S.devSync ? view : dev));
  $('devSync').onclick = () => { S.devSync = !S.devSync; save(); render(); };
  $('devMode').addEventListener('change', (e) => { S.devMode = e.target.value; save(); render(); });
  $('devRange').addEventListener('change', (e) => { S.devRange = +e.target.value; save(); render(); });
  $('devChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const x = +b.dataset.x, slot = S.devTargets.indexOf(x);
    if (slot >= 0) S.devTargets[slot] = null;
    else {
      const free = S.devTargets.indexOf(null);
      if (free < 0) return toast('Up to 4 lines', 'Turn one target off before adding another.');
      S.devTargets[free] = x;
    }
    save(); render();
  });
}

// ---------- strategy generator ----------
//
// A strategy = one target to follow, a start rule, an end rule and a staking plan,
// for the next `period` rounds. Candidates are built from the system's own signals
// (default chance, Since, adjusted gap, the row alert %), scored exactly from the
// default chance, and replayed over every past period of the loaded history.

const STAKING = {
  flat: 'Flat',
  step: 'Step-up',
  recovery: 'Recovery',
  every: 'Every round',
};
let strat = null; // { at: round id generated after, list: [...], tried: n }

// Stake for each bet of an n-bet plan with base stake b and payout `pay`.
function stakesFor(plan, b, n, pay) {
  const s = [];
  if (plan === 'step') {
    const cut = Math.ceil((n * 2) / 3); // like 40 of 60 at the base stake, then double
    for (let k = 1; k <= n; k++) s.push(k <= cut ? b : 2 * b);
  } else if (plan === 'recovery') {
    // Each stake is sized so a hit recovers every earlier loss plus the first bet's win.
    let spent = 0;
    for (let k = 1; k <= n; k++) {
      const st = k === 1 ? b : (spent + b * (pay - 1)) / (pay - 1);
      s.push(st);
      spent += st;
    }
  } else {
    for (let k = 0; k < n; k++) s.push(b);
  }
  return s;
}

// A plan never stakes more than the budget in total: it ends early when the next stake would exceed it.
function fitBudget(stakes, budget) {
  let sum = 0, n = 0;
  while (n < stakes.length && sum + stakes[n] <= budget + 1e-9) sum += stakes[n++];
  return stakes.slice(0, n);
}

// Exact outcome distribution from the default chance p.
// Stop-at-first-hit plans end at the first hit; 'every' bets every round of the plan.
function theory(p, pay, stakes, every, budget) {
  const n = stakes.length, q = 1 - p, total = stakes.reduce((a, v) => a + v, 0);
  const out = []; // [probability, profit]
  let expStaked = 0;
  if (every) {
    const s = stakes[0];
    let pr = q ** n;
    for (let h = 0; h <= n; h++) {
      out.push([pr, s * (pay * h - n)]);
      pr = (pr * (n - h) * p) / ((h + 1) * q);
    }
    expStaked = total;
  } else {
    let reach = 1, spent = 0;
    for (let k = 0; k < n; k++) {
      spent += stakes[k];
      expStaked += reach * stakes[k];
      out.push([reach * p, stakes[k] * pay - spent]);
      reach *= q;
    }
    out.push([reach, -total]);
  }
  let pWin = 0, pLoss = 0, exp = 0, best = -Infinity;
  for (const [pr, v] of out) {
    if (v > 1e-9) pWin += pr;
    else if (v < -1e-9) pLoss += pr;
    exp += pr * v;
    if (pr > 1e-12 && v > best) best = v;
  }
  // Risk 0–100: half the chance of ending down, half the share of the budget that can be lost.
  // The second half keeps "win a little often, lose a lot rarely" plans from looking safe.
  const atStake = total / budget;
  const risk = Math.round(clamp(50 * pLoss + 50 * atStake, 0, 100));
  return { pWin, pLoss, atStake, exp, expStaked, ret: (expStaked + exp) / expStaked, maxLoss: total, best, risk };
}

// Hits and last-hit index per round (oldest first) for one target, for fast replays.
function hitSeries(asc, x) {
  const n = asc.length, hit = new Uint8Array(n), pref = new Int32Array(n + 1), last = new Int32Array(n);
  let lh = -1;
  for (let i = 0; i < n; i++) {
    hit[i] = isHit(asc[i][1], x) ? 1 : 0;
    pref[i + 1] = pref[i] + hit[i];
    if (hit[i]) lh = i;
    last[i] = lh;
  }
  return { hit, pref, last };
}

// Start offset and number of bets for a rule, given Since and the adjusted gap at that moment.
function planShape(rule, since, adj, avg, period) {
  const t0 = rule.f ? Math.max(0, Math.ceil(rule.f * adj - since)) : 0;
  if (t0 >= period) return null;
  const n = rule.len === 'rest' ? period - t0 : Math.min(period - t0, Math.max(1, Math.round(rule.len * avg)));
  return { t0, n };
}

// Replay a rule over every past period: the state at each period's start comes only
// from the rounds before it, exactly as the live strategy would have seen it.
function backtest(asc, ser, rule, x, p, pay, period, b, w, budget) {
  const avg = 1 / p;
  let periods = 0, wins = 0, staked = 0, returned = 0, worst = 0, sum = 0;
  for (let i = Math.max(w, 1); i + period <= asc.length; i += period) {
    const rate = (ser.pref[i] - ser.pref[i - w]) / w;
    const adj = avg * clamp(rate / p, 0.25, 4);
    const since = ser.last[i - 1] < 0 ? i : i - 1 - ser.last[i - 1];
    const shape = planShape(rule, since, adj, avg, period);
    if (!shape) continue;
    const st = fitBudget(stakesFor(rule.plan === 'every' ? 'flat' : rule.plan, b, shape.n, pay), budget);
    if (!st.length) continue;
    let s = 0, r = 0;
    for (let k = 0; k < st.length; k++) {
      s += st[k];
      if (ser.hit[i + shape.t0 + k]) { r += st[k] * pay; if (rule.plan !== 'every') break; }
    }
    periods++; staked += s; returned += r;
    const pr = r - s;
    sum += pr;
    if (pr > 1e-9) wins++;
    if (pr < worst) worst = pr;
  }
  return periods ? { periods, pWin: wins / periods, ret: returned / staked, avgProfit: sum / periods, worst } : null;
}

const GOALS = {
  balanced: (c) => (0.5 * c.th.pWin + 0.5 * (c.bt ? c.bt.pWin : c.th.pWin)) * (1 - c.th.risk / 100),
  safe: (c) => -c.th.risk + 0.01 * c.th.pWin,
  history: (c) => (c.bt && c.bt.periods >= 20 ? c.bt.ret : -Infinity),
  payout: (c) => (c.th.risk <= 60 ? c.th.best : -Infinity),
};

function generateStrategies() {
  if (!games.length) return;
  const period = S.stratPeriod, b = S.stratStake, budget = S.stratBudget, w = Math.min(win(), games.length - 1);
  const asc = [...games].reverse();
  const cands = [], seen = new Set();
  for (const x of S.targets) {
    const pay = x === 1 ? S.onePay : x;
    if (!pay || pay <= 1) continue; // 1.00× only when its payout is set
    const p = prob(x), avg = 1 / p, m = model(x), ser = hitSeries(asc, x);
    const triggers = [...new Set([0, rowPctOf(x) / 100, 0.8, 1.2])];
    for (const f of triggers) for (const len of [1, 2, 'rest']) for (const plan of Object.keys(STAKING)) {
      const rule = { f, len, plan };
      const shape = planShape(rule, m.k, m.adjGap, avg, period);
      if (!shape) continue;
      const stakes = fitBudget(stakesFor(plan === 'every' ? 'flat' : plan, b, shape.n, pay), budget);
      if (!stakes.length) continue; // even one stake exceeds the budget
      const key = [x, shape.t0, stakes.length, plan].join('|');
      if (seen.has(key)) continue; // e.g. "2 gaps" capped to the same length as "rest"
      seen.add(key);
      const th = theory(p, pay, stakes, plan === 'every', budget);
      const bt = backtest(asc, ser, rule, x, p, pay, period, b, w, budget);
      cands.push({ x, pay, p, avg, rule, t0: shape.t0, n: stakes.length, cut: stakes.length < shape.n, stakes, th, bt, adj: m.adjGap, since: m.k });
    }
  }
  const goal = GOALS[S.stratGoal] || GOALS.balanced;
  cands.forEach((c) => (c.score = goal(c)));
  cands.sort((a, b2) => b2.score - a.score);
  // Top 5, preferring one plan per target so the picks are not five versions of one idea.
  const list = [], used = new Set();
  for (const c of cands) if (list.length < 5 && Number.isFinite(c.score) && !used.has(c.x)) { list.push(c); used.add(c.x); }
  for (const c of cands) if (list.length < 5 && Number.isFinite(c.score) && !list.includes(c)) list.push(c);
  strat = { at: games[0][0], list, tried: cands.length };
  renderStrategy();
}

const money = (v) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
function riskLabel(r) {
  if (r < 25) return { label: 'Low', color: 'good' };
  if (r < 50) return { label: 'Medium', color: 'warn' };
  if (r < 75) return { label: 'High', color: 'series-hi' };
  return { label: 'Very high', color: 'bad' };
}

function stakeText(c) {
  const s = c.stakes, b = s[0];
  if (c.rule.plan === 'step') {
    const cut = s.findIndex((v) => v > b);
    return cut < 0 ? `${money(b)} every bet` : `${money(b)} for ${cut} bets, then ${money(2 * b)}`;
  }
  if (c.rule.plan === 'recovery') return `${money(b)}, raised after each miss (max ${money(Math.max(...s))})`;
  return `${money(b)} every ${c.rule.plan === 'every' ? 'round' : 'bet'}`;
}

function strategyCard(c, rank) {
  const startId = strat.at + 1 + c.t0, endId = startId + c.n - 1; // relative to the round it was built from
  const rk = riskLabel(c.th.risk);
  const every = c.rule.plan === 'every';
  const startText = c.t0 === 0 ? 'Next round' : `In ${c.t0} round${c.t0 === 1 ? '' : 's'}`;
  const why = c.rule.f
    ? `when Since reaches ${Math.round(c.rule.f * 100)}% of adj. gap (${gap(c.rule.f * c.adj)}; now ${int(c.since)})`
    : 'no waiting';
  const endText = every ? `After ${c.n} rounds` : `First hit, or after ${c.n} bets`;
  const cutNote = c.cut ? ' · shortened to fit the budget' : '';
  const winText = every ? `${signed(c.th.best)} best case` : `${signed(c.stakes[0] * c.pay - c.stakes[0])} if bet 1 hits`;
  const bt = c.bt;
  const slots = S.stratPeriod;
  return `<article class="st-card ${rank === 0 ? 'st-top' : ''}">
    <header>
      <span class="st-rank">${rank === 0 ? 'Top pick' : '#' + (rank + 1)}</span>
      <h3>Follow ${tlabel(c.x)}</h3>
      <span class="phase" style="--c: var(--${rk.color})" data-tip="Risk score ${c.th.risk}/100 = 50 × chance of ending down (${pct(c.th.pLoss)}) + 50 × share of your budget that can be lost (${pct(c.th.atStake)})">Risk ${c.th.risk} · ${rk.label}</span>
    </header>
    <div class="st-when">
      <div><span class="label">Start</span><b>${startText}</b><span class="sub">#${startId} · ${why}</span></div>
      <div><span class="label">End</span><b>${endText}</b><span class="sub">latest #${endId}${every ? '' : ' · stop when it hits'}${cutNote}</span></div>
    </div>
    <div class="st-timeline" data-tip="Next ${slots} rounds: waiting ${c.t0}, then up to ${c.n} ${every ? 'rounds' : 'bets'}">
      <i style="left:${(c.t0 / slots) * 100}%; width:${(c.n / slots) * 100}%"></i>
    </div>
    <div class="st-stats">
      <div data-tip="Expected return on everything you stake. From the game's default chance this is ×0.99 for every plan (1% house edge)${bt ? `; over ${bt.periods} past periods this rule returned ×${bt.ret.toFixed(3)}` : ''}">
        <span class="label">Expected total multiplier</span><b>×${c.th.ret.toFixed(3)}</b>
        <span class="sub">${bt ? `history ×${bt.ret.toFixed(3)}` : 'no past period triggered'}</span></div>
      <div data-tip="Chance the plan ends with a profit${bt ? `; it ended in profit in ${pct(bt.pWin)} of ${bt.periods} past periods` : ''}">
        <span class="label">Chance of profit</span><b>${pct(c.th.pWin)}</b>
        <span class="sub">${bt ? `history ${pct(bt.pWin)}` : '—'}</span></div>
      <div data-tip="Expected profit = −1% of the expected amount staked (${money(c.th.expStaked)})">
        <span class="label">Expected profit</span><b>${signed(c.th.exp)}</b><span class="sub">${winText}</span></div>
      <div data-tip="What you lose if no bet hits: ${pct(c.th.atStake)} of your budget${bt ? `; the worst past period lost ${money(-bt.worst)}` : ''}">
        <span class="label">Max loss</span><b class="neg">${money(-c.th.maxLoss)}</b><span class="sub">${pct(c.th.atStake)} of budget</span></div>
    </div>
    <footer>
      <span class="sub">${STAKING[c.rule.plan]}: ${stakeText(c)} · pays ×${c.pay}</span>
      <button class="btn small st-track" data-i="${rank}">Track this plan</button>
    </footer>
  </article>`;
}

// ---- tracking a chosen plan through the coming rounds (you place the bets) ----

function planState(pl) {
  const top = games[0]?.[0] ?? 0, endId = pl.startId + pl.stakes.length - 1;
  let k = 0, staked = 0, returned = 0, hits = 0, won = false;
  for (let id = pl.startId; id <= Math.min(top, endId); id++) {
    const g = byId.get(id);
    if (!g) break;
    staked += pl.stakes[k];
    if (isHit(g[1], pl.x)) { returned += pl.stakes[k] * pl.pay; hits++; }
    k++;
    if (hits && !pl.every) { won = true; break; }
  }
  const status = won ? 'won' : top < pl.startId ? 'waiting' : k >= pl.stakes.length ? 'ended' : 'active';
  return { k, staked, returned, profit: returned - staked, hits, status, next: pl.stakes[k], endId, toStart: pl.startId - top - 1 };
}

function checkPlan(before) {
  if (!S.plan || !before) return;
  const pl = S.plan, now = planState(pl);
  const what = `${tlabel(pl.x)} at ×${pl.pay}`;
  if (now.status === 'waiting' && now.toStart === 0 && before.toStart !== 0) notify('Plan starts next round', `Bet 1: ${money(pl.stakes[0])} on ${what}`, 'plan');
  if (before.status === 'waiting' && now.status === 'active' && now.k > 0) notify('Plan started', `Next: bet ${now.k + 1}, ${money(now.next)} on ${what}`, 'plan');
  if (now.hits > before.hits) notify(`${tlabel(pl.x)} hit`, `Plan P&L ${signed(now.profit)} after ${now.k} bet${now.k === 1 ? '' : 's'}`, 'plan');
  if ((now.status === 'won' || now.status === 'ended') && before.status !== now.status) {
    notify(now.profit > 0 ? 'Plan finished in profit' : 'Plan finished', `${now.k} bets · staked ${money(now.staked)} · P&L ${signed(now.profit)}`, 'plan');
  }
}

function renderPlanBox() {
  const box = $('planBox');
  if (!S.plan || !games.length) { box.hidden = true; return; }
  const pl = S.plan, st = planState(pl), n = pl.stakes.length;
  const label = { waiting: 'Waiting', active: 'Active', won: 'Hit — finished', ended: 'Finished' }[st.status];
  const color = { waiting: 'text-muted', active: 'series-lo', won: 'good', ended: st.profit > 0 ? 'good' : 'bad' }[st.status];
  const nextLine = st.status === 'waiting'
    ? (st.toStart === 0 ? `<b>Bet 1 next round:</b> ${money(pl.stakes[0])}` : `Starts in ${st.toStart} round${st.toStart === 1 ? '' : 's'} (#${pl.startId})`)
    : st.status === 'active' ? `<b>Next round: bet ${st.k + 1} of ${n}</b> · stake ${money(st.next)}` : `Done after ${st.k} bet${st.k === 1 ? '' : 's'}`;
  box.hidden = false;
  box.innerHTML = `
    <div class="pb-main">
      <span class="label">Tracking</span>
      <b>Follow ${tlabel(pl.x)} · ${STAKING[pl.plan]}</b>
      <span class="phase" style="--c: var(--${color})">${label}</span>
    </div>
    <div class="pb-next">${nextLine}</div>
    <div class="pb-bar" data-tip="${st.k} of ${n} bets played"><i style="width:${(st.k / n) * 100}%"></i></div>
    <div class="pb-nums">
      <span>Staked <b>${money(st.staked)}</b></span>
      <span>Returned <b>${money(st.returned)}</b></span>
      <span>P&amp;L <b class="${st.profit > 0 ? 'pos' : st.profit < 0 ? 'neg' : ''}">${signed(st.profit)}</b></span>
    </div>
    <button class="btn small ghost" id="planStop">${st.status === 'won' || st.status === 'ended' ? 'Clear' : 'Stop tracking'}</button>`;
}

function renderStrategy() {
  renderPlanBox();
  for (const [id, v] of [['stStake', S.stratStake], ['stBudget', S.stratBudget], ['stPeriod', S.stratPeriod], ['stOnePay', S.onePay ?? '']]) {
    if (document.activeElement !== $(id)) $(id).value = v;
  }
  $('stGoal').value = S.stratGoal;
  if (!strat) { $('stMeta').textContent = 'Click Generate to build plans for the next rounds.'; $('stCards').innerHTML = ''; return; }
  const ago = games[0][0] - strat.at;
  $('stMeta').innerHTML = `Built from the state after round #${strat.at}${ago ? ` · <b class="warn-t">${ago} new round${ago === 1 ? '' : 's'} since — regenerate for fresh timing</b>` : ''}
    · ${strat.tried} plans compared, each replayed over the loaded history`;
  const html = strat.list.length ? strat.list.map(strategyCard).join('') : '<p class="sub">No plan starts within this period. Try a longer period.</p>';
  if ($('stCards').dataset.html !== html) { $('stCards').innerHTML = html; $('stCards').dataset.html = html; }
}

function initStrategy() {
  const num = (id, key, min, max, def) => $(id).addEventListener('change', (e) => {
    const v = +e.target.value;
    S[key] = Number.isFinite(v) && v >= min ? Math.min(v, max) : def;
    save(); generateStrategies();
  });
  num('stStake', 'stratStake', 0.01, 1e6, 0.25);
  num('stPeriod', 'stratPeriod', 10, 500, 100);
  num('stBudget', 'stratBudget', 0.01, 1e9, 20);
  $('stOnePay').addEventListener('change', (e) => {
    const v = +e.target.value;
    S.onePay = e.target.value === '' || !(v > 1) ? null : v;
    save(); generateStrategies();
  });
  $('stGoal').addEventListener('change', (e) => { S.stratGoal = e.target.value; save(); generateStrategies(); });
  $('stGen').onclick = generateStrategies;
  $('stCards').addEventListener('click', async (e) => {
    const b = e.target.closest('.st-track');
    if (!b || !strat) return;
    if (games[0][0] !== strat.at) {
      // New rounds arrived since these plans were built: rebuild so the timing is current.
      generateStrategies();
      return toast("Plans refreshed", "New rounds arrived, so the plans were rebuilt for the latest round. Check the pick and click Track again.");
    }
    const c = strat.list[+b.dataset.i];
    S.plan = { x: c.x, pay: c.pay, plan: c.rule.plan, every: c.rule.plan === 'every', startId: strat.at + 1 + c.t0, stakes: c.stakes };
    save();
    await askNotifyPermission();
    render();
  });
  $('planBox').addEventListener('click', (e) => {
    if (e.target.closest('#planStop')) { S.plan = null; save(); render(); }
  });
}

// ---------- render loop ----------

let queued = false;
let flashNext = false;
function render(flash = false) {
  flashNext ||= flash;
  if (queued || !games.length) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    renderHeader(flashNext);
    flashNext = false;
    renderOverview();
    document.querySelectorAll('[data-card^="focus"]').forEach((card) => {
      if (!card.contains(document.activeElement) || !document.activeElement.matches('.drought')) renderFocus(card);
    });
    renderChart();
    renderDensity();
    renderDev();
    renderProbs();
    renderStrategy();
    renderAnalysis();
  });
}

// ---------- tooltip, toasts, alerts ----------

const tip = $('tip');
function showTip(html, e) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = clamp(e.clientX + 14, 8, innerWidth - r.width - 8) + 'px';
  tip.style.top = (e.clientY - r.height - 14 < 8 ? e.clientY + 18 : e.clientY - r.height - 14) + 'px';
}
function hideTip() { tip.hidden = true; }
const gameTip = (g) => `<b>#${g[0]}</b> &nbsp;${fmt(g[1])}<br><span class="muted">${
  !g[2] ? 'time n/a' : g[3] ? `≈ ${new Date(g[2]).toLocaleString()} (estimated)` : new Date(g[2]).toLocaleString()}</span>`;

document.addEventListener('mousemove', (e) => {
  if (e.target.closest?.('#chart, #devChart')) return;
  const g = e.target.closest?.('[data-g]');
  if (g && byId.has(+g.dataset.g)) return showTip(gameTip(byId.get(+g.dataset.g)), e);
  const t = e.target.closest?.('[data-tip]');
  if (t) return showTip(t.dataset.tip, e);
  hideTip();
});

let audio;
function beep() {
  if (!S.sound) return;
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + 0.5);
  } catch {}
}

// Browsers only allow sound after the page has been clicked once; unlock it then.
document.addEventListener('pointerdown', () => { try { audio ??= new AudioContext(); audio.resume(); } catch {} }, { once: true });

// In-page message only (info, not an alert).
function toast(title, body, ms = 8000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<b>${title}</b>${body}`;
  $('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

// Alerts: in-page toast + sound + a browser (OS) notification that shows even when
// you are working in another window. It stays on screen until dismissed; clicking it
// brings the dashboard to the front. The tab title also counts unseen alerts.
const baseTitle = document.title;
let unseen = 0;
addEventListener('focus', () => { unseen = 0; document.title = baseTitle; });
function notify(title, body, tag) {
  toast(title, body);
  beep();
  if (!document.hasFocus()) { unseen++; document.title = `(${unseen}) 🔔 ${title}`; }
  if (window.Notification?.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag, renotify: !!tag, requireInteraction: true });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}

function notifyState() {
  if (!window.Notification) return 'unsupported';
  return Notification.permission; // 'granted' | 'denied' | 'default'
}

function renderNotifyBtn() {
  const b = $('notifyBtn'), st = notifyState();
  const ui = {
    granted: ['Desktop alerts on', 'Browser notifications are allowed. Click to send a test notification.'],
    default: ['Enable desktop alerts', 'Click to allow browser notifications, so alerts show even when you are in another window.'],
    denied: ['Desktop alerts blocked', 'Notifications are blocked for this site. Click for how to allow them.'],
    unsupported: ['Desktop alerts unavailable', 'This browser cannot show notifications here. Open the dashboard at http://localhost:3000 in Chrome or Edge.'],
  }[st];
  b.textContent = ui[0];
  b.dataset.tip = ui[1];
  b.dataset.state = st;
}

async function askNotifyPermission() {
  if (!window.Notification) return toast('Browser notifications unavailable', 'Open the dashboard at http://localhost:3000 in Chrome or Edge. In-page alerts and sound still work.');
  if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} }
  renderNotifyBtn();
  if (Notification.permission === 'denied') {
    toast('Browser notifications are blocked',
      'Click the icon left of the address bar → Site settings → Notifications → Allow, then reload this page. In-page alerts and sound still work.', 15000);
  }
}

async function testNotify() {
  await askNotifyPermission();
  if (notifyState() !== 'granted') return;
  notify('Test alert', 'Desktop alerts are working. You will see alerts like this even when another window is in front.', 'test');
  toast("Didn't see a Windows notification?",
    'Check Windows Settings → System → Notifications: notifications on, your browser allowed, and Do not disturb off.', 15000);
}

const fired = {};
function checkAlerts(fresh) {
  for (const x of S.targets) if (S.rowAlerts[x]) rowAlert(x, !fresh);
  for (const [id, c] of Object.entries(S.focus)) {
    if (fresh && c.notifyHit) {
      for (const g of fresh) if (isHit(g[1], c.x)) notify(`${tname(c.x)} hit`, `Round #${g[0]} → ${fmt(g[1])}`);
    }
    if (c.droughtAt > 0) {
      const k = stats(games, c.x).since, key = `${id}:${c.x}:${c.droughtAt}`;
      if (k >= c.droughtAt && !fired[key] && fresh) notify(`${tname(c.x)} gap reached ${int(k)}`, `No ${tname(c.x)} for ${int(k)} rounds`);
      fired[key] = k >= c.droughtAt;
    }
  }
}

// Fires once per gap when rounds since the last hit reach the row's % of the adjusted gap.
function rowAlert(x, silent) {
  const m = model(x), pctX = rowPctOf(x);
  const at = (m.adjGap * pctX) / 100;
  const key = `row:${x}:${m.all.last?.[0] ?? 'none'}:${pctX}`;
  if (m.k < at || fired[key]) return;
  fired[key] = true;
  if (!silent) {
    notify(`${tlabel(x)} reached ${pctX}% of adj. gap`,
      `${int(m.k)} rounds since last · adj. gap ${gap(m.adjGap)} · Due ${pct(m.due)}`, `row-${x}`);
  }
}

// ---------- draggable, resizable board ----------

function initBoard() {
  const board = $('board');
  const cards = () => [...board.querySelectorAll('.card')];
  const defaults = cards().map((c) => [c.dataset.card, +c.dataset.span]);
  const apply = (layout) => {
    for (const [id, span] of layout) {
      const c = board.querySelector(`[data-card="${id}"]`);
      if (c) { c.dataset.span = span; board.append(c); }
    }
    // Panels added after the layout was saved go back next to their default neighbour.
    const ids = layout.map(([id]) => id);
    defaults.forEach(([id], k) => {
      if (ids.includes(id)) return;
      const c = board.querySelector(`[data-card="${id}"]`);
      const prev = k ? board.querySelector(`[data-card="${defaults[k - 1][0]}"]`) : null;
      if (prev) prev.after(c); else board.prepend(c);
    });
    cards().forEach((c) => c.style.setProperty('--span', c.dataset.span));
  };
  const saveLayout = () => { S.layout = cards().map((c) => [c.dataset.card, +c.dataset.span]); save(); };
  apply(S.layout || defaults);

  // Move panels by dragging their grip (pointer events: works with mouse and touch).
  let dragging = null;
  board.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.grip');
    if (!g || e.button !== 0) return;
    e.preventDefault();
    dragging = g.closest('.card');
    dragging.classList.add('dragging');
    document.body.classList.add('moving');
    g.setPointerCapture(e.pointerId);
    hideTip();
  });
  board.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (e.clientY < 70) scrollBy(0, -12);
    else if (e.clientY > innerHeight - 50) scrollBy(0, 12);
    const over = document.elementsFromPoint(e.clientX, e.clientY).map((el) => el.closest('.card')).find((c) => c && c !== dragging);
    if (!over) return;
    const r = over.getBoundingClientRect();
    const after = +over.dataset.span >= 12 ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
    const ref = after ? over.nextElementSibling : over;
    if (ref !== dragging && ref !== dragging.nextElementSibling) board.insertBefore(dragging, ref);
  });
  const drop = () => {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    document.body.classList.remove('moving');
    dragging = null;
    saveLayout();
    render();
  };
  board.addEventListener('pointerup', drop);
  board.addEventListener('pointercancel', drop);
  board.addEventListener('click', (e) => {
    const b = e.target.closest('.size');
    if (!b) return;
    const c = b.closest('.card');
    c.dataset.span = SPANS[(SPANS.indexOf(+c.dataset.span) + 1) % SPANS.length];
    c.style.setProperty('--span', c.dataset.span);
    saveLayout();
    render();
  });
  $('resetLayout').onclick = () => { S.layout = null; save(); apply(defaults); render(); };

  new ResizeObserver(() => render()).observe(board);
}

// ---------- controls ----------

function initControls() {
  $('winSel').addEventListener('change', (e) => { S.win = +e.target.value; page = 1; save(); render(); });
  $('soundBtn').onclick = () => { S.sound = !S.sound; save(); render(); if (S.sound) beep(); };
  $('notifyBtn').onclick = testNotify;

  // Keyboard shortcuts for the round charts (ignored while typing in a field).
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'p') S.chartMode = 'pan';
    else if (k === 's') S.chartMode = 'select';
    else if (k === 'l') view.offset = 0;
    else if (k === '+' || k === '=') view.count /= 1.5;
    else if (k === '-' || k === '_') view.count *= 1.5;
    else if (k === 'escape' && S.sel) S.sel = null;
    else return;
    e.preventDefault();
    save();
    render();
  });
  renderNotifyBtn();
  // Permission can change in the browser's site settings while the page is open.
  navigator.permissions?.query({ name: 'notifications' }).then((p) => { p.onchange = renderNotifyBtn; }).catch(() => {});
  $('inX').addEventListener('input', (e) => {
    const v = +e.target.value;
    if (v >= 1.01) { S.payout = v; page = 1; save(); render(); }
  });
  $('prev').onclick = () => { page--; render(); };
  $('next').onclick = () => { page++; render(); };
  $('pageIn').addEventListener('change', (e) => { page = +e.target.value || 1; render(); });

  $('addTarget').addEventListener('submit', (e) => {
    e.preventDefault();
    let v = Math.round(+$('targetIn').value * 100) / 100;
    if (!(v === 1 || v >= 1.01)) return;
    if (!S.targets.includes(v)) S.targets.push(v);
    $('targetIn').value = '';
    save(); render();
  });
  $('probBody').addEventListener('click', async (e) => {
    const bell = e.target.closest('.row-bell');
    if (bell) {
      const x = +bell.dataset.x;
      if (S.rowAlerts[x]) delete S.rowAlerts[x];
      else { S.rowAlerts[x] = true; save(); await askNotifyPermission(); rowAlert(x, false); }
      save(); render();
      return;
    }
    const b = e.target.closest('.del');
    if (!b) return;
    S.targets = S.targets.filter((x) => x !== +b.dataset.x);
    delete S.rowAlerts[+b.dataset.x];
    delete S.rowPct[+b.dataset.x];
    save(); render();
  });
  // Per-row threshold: Enter or leaving the box applies it; an empty box means "use the default".
  $('probBody').addEventListener('change', (e) => {
    const inp = e.target.closest('.row-pct');
    if (!inp) return;
    const x = +inp.dataset.x;
    if (inp.value === '') delete S.rowPct[x];
    else S.rowPct[x] = clamp(Math.round(+inp.value), 1, 500);
    save();
    inp.blur();
    if (S.rowAlerts[x]) rowAlert(x, false);
    render();
  });
  $('probBody').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.row-pct')) e.target.blur();
    if (e.key === 'Escape' && e.target.matches('.row-pct')) { e.target.value = S.rowPct[+e.target.dataset.x] ?? ''; e.target.blur(); }
  });
  $('probBody').addEventListener('focusout', () => setTimeout(render)); // catch up on rounds skipped while typing
  $('alertPct').value = S.alertPct;
  $('alertPct').addEventListener('change', (e) => {
    S.alertPct = clamp(Math.round(+e.target.value || 95), 1, 500);
    e.target.value = S.alertPct;
    save();
    for (const x of S.targets) if (S.rowAlerts[x] && S.rowPct[x] == null) rowAlert(x, false);
    render();
  });


  const board = $('board');
  board.addEventListener('change', (e) => {
    const card = e.target.closest('[data-card^="focus"]');
    if (!card) return;
    const cfg = S.focus[card.dataset.card];
    if (e.target.matches('.focus-target')) cfg.x = +e.target.value;
    if (e.target.matches('.drought')) {
      cfg.droughtAt = Math.max(0, Math.round(+e.target.value || 0));
      e.target.blur(); // done typing: let the tracker refresh again
    }
    save(); checkAlerts(null); render();
  });
  board.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.drought')) e.target.blur(); });
  board.addEventListener('focusout', (e) => { if (e.target.matches('.drought')) setTimeout(render); });
  board.addEventListener('click', async (e) => {
    const b = e.target.closest('.bell:not(.row-bell)');
    if (!b) return;
    const cfg = S.focus[b.closest('.card').dataset.card];
    if (!cfg) return;
    cfg.notifyHit = !cfg.notifyHit;
    if (cfg.notifyHit) await askNotifyPermission();
    save(); render();
  });
}

// ---------- live data ----------

function connect() {
  const es = new EventSource('/events');
  const status = (ok, text) => {
    $('status').className = 'status ' + (ok ? 'ok' : 'err');
    $('status').lastElementChild.textContent = text;
  };
  es.addEventListener('snapshot', (e) => {
    games = JSON.parse(e.data).games;
    if (games.length) { document.body.classList.remove('is-loading'); $('loading').hidden = true; }
    byId.clear();
    for (const g of games) byId.set(g[0], g);
    checkAlerts(null);
    if (!strat) generateStrategies();
    render();
  });
  es.addEventListener('games', (e) => {
    const fresh = JSON.parse(e.data); // oldest first
    const planBefore = S.plan && games.length ? planState(S.plan) : null;
    for (const g of fresh) { games.unshift(g); byId.set(g[0], g); }
    if (view.offset > 0) view.offset += fresh.length; // keep a panned chart still
    checkAlerts(fresh);
    checkPlan(planBefore);
    render(true);
  });
  es.addEventListener('status', (e) => {
    const s = JSON.parse(e.data);
    status(s.ok, s.ok ? `Live · ${s.host}` : `Error: ${s.error}`);
  });
  es.onerror = () => status(false, 'Disconnected — retrying…');
}

initBoard();
initChart();
initDev();
initStrategy();
initControls();
connect();
