'use strict';
// Strategy engine, run in a Web Worker so rebuilding plans every round never stalls the page.
//
// A plan is a looping rule for one target: wait until Since reaches f × adjusted gap
// (f = 0: start at once), bet up to n times (stop at the first hit unless it is an
// every-round plan), then wait for the trigger again — over and over until stopped.
// Each candidate is scored two ways over the next `period` rounds:
//   - simulated from the game's default chance (the honest forward-looking view);
//   - replayed over every past period of the loaded history (how the rule did).

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const prob = (x) => (x === 1 ? 2 / 101 : 0.99 / x);
const isHit = (r, x) => (x === 1 ? r < 1.01 : r >= x);

// Stake for each bet of an n-bet cycle with base stake b and payout `pay`.
function stakesFor(plan, b, n, pay) {
  const s = [];
  if (plan === 'step') {
    const cut = Math.ceil((n * 2) / 3); // like 40 of 60 at the base stake, then double
    for (let k = 1; k <= n; k++) s.push(k <= cut ? b : 2 * b);
  } else if (plan === 'recovery') {
    // Each stake is sized so a hit recovers every earlier loss in the cycle plus the first bet's win.
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

// A cycle never stakes more than the budget in total: it ends early instead.
function fitBudget(stakes, budget) {
  let sum = 0, n = 0;
  while (n < stakes.length && sum + stakes[n] <= budget + 1e-9) sum += stakes[n++];
  return stakes.slice(0, n);
}

// xorshift32: fast and seeded, so the same inputs give the same picks every rebuild.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const seedOf = (r) => Math.round(r.x * 1000) * 7919 + Math.round(r.f * 100) * 104729 + r.len * 1299709 + r.plan.length * 15485863;

// One period of H rounds for a looping rule.
// seq[t]: hit at round t; out[t]: the hit leaving the trailing w-round window at round t.
function runPeriod(R, H, w, since, count, seq, out) {
  let staked = 0, ret = 0, k = -1, cycles = 0;
  for (let t = 0; t < H; t++) {
    if (k < 0 && since >= R.f * R.avg * clamp(count / w / R.p, 0.25, 4)) { k = 0; cycles++; }
    const h = seq[t];
    if (k >= 0) {
      const st = R.stakes[k];
      staked += st;
      if (h) ret += st * R.pay;
      k = h && !R.every ? -1 : k + 1;
      if (k >= R.stakes.length) k = -1;
    }
    since = h ? 0 : since + 1;
    count += h - out[t];
  }
  return { staked, ret, cycles };
}

function evaluate(R, T, H, w, sims, budget) {
  const rand = rng(seedOf(R));
  const seq = new Uint8Array(H), out = new Uint8Array(H), profits = new Float64Array(sims);
  let stakedSum = 0, cyc = 0, wins = 0, losses = 0, idle = 0;
  for (let s = 0; s < sims; s++) {
    for (let t = 0; t < H; t++) seq[t] = rand() < R.p ? 1 : 0;
    for (let t = 0; t < H; t++) out[t] = t < w ? T.hit[T.n - w + t] : seq[t - w];
    const r = runPeriod(R, H, w, T.since0, T.count0, seq, out);
    const pr = r.ret - r.staked;
    profits[s] = pr;
    stakedSum += r.staked; cyc += r.cycles;
    if (pr > 1e-9) wins++; else if (pr < -1e-9) losses++;
    if (!r.staked) idle++;
  }
  profits.sort();
  const bad = profits[Math.floor(0.05 * sims)]; // 1-in-20 bad case
  // Worst case: every round misses.
  seq.fill(0);
  for (let t = 0; t < H; t++) out[t] = t < w ? T.hit[T.n - w + t] : 0;
  const worst = runPeriod(R, H, w, T.since0, T.count0, seq, out);

  // Same rule over every past period: the state at each start comes only from earlier rounds.
  let periods = 0, bw = 0, bs = 0, br = 0, bworst = 0;
  for (let i = w; i + H <= T.n; i += H) {
    const since = T.last[i - 1] < 0 ? i : i - 1 - T.last[i - 1];
    const count = T.pref[i] - T.pref[i - w];
    const r = runPeriod(R, H, w, since, count, T.hit.subarray(i, i + H), T.hit.subarray(i - w, i - w + H));
    if (!r.staked) continue;
    periods++; bs += r.staked; br += r.ret;
    const pr = r.ret - r.staked;
    if (pr > 1e-9) bw++;
    if (pr < bworst) bworst = pr;
  }

  const ret = R.pay * R.p; // exact: every bet returns pay × p of its stake on average (0.99 for ≥ targets)
  const expStaked = stakedSum / sims;
  const pLoss = losses / sims;
  const risk = Math.round(clamp(50 * pLoss + 50 * Math.min(1, Math.max(0, -bad) / budget), 0, 100));
  return {
    sim: { pWin: wins / sims, pLoss, idle: idle / sims, expStaked, cycles: cyc / sims, bad, ret, exp: (ret - 1) * expStaked },
    maxLoss: worst.staked - worst.ret,
    bt: periods ? { periods, pWin: bw / periods, ret: br / bs, worst: bworst } : null,
    risk,
  };
}

const GOALS = {
  balanced: (c) => (0.5 * c.sim.pWin + 0.5 * (c.bt ? c.bt.pWin : c.sim.pWin)) * (1 - c.risk / 100),
  safe: (c) => -c.risk + 0.01 * c.sim.pWin,
  history: (c) => (c.bt && c.bt.periods >= 20 ? c.bt.ret : -Infinity),
  payout: (c) => (c.risk <= 60 ? c.stakes[0] * (c.pay - 1) : -Infinity),
};

self.onmessage = (e) => {
  const t0 = performance.now();
  const { at, rates, targets, rowPct, period: H, stake: b, budget, window: w0, goal, onePay, sims = 1000 } = e.data;
  const n = rates.length, w = Math.max(1, Math.min(w0, n - 1));
  const cands = [], seen = new Set();
  for (const x of targets) {
    const pay = x === 1 ? onePay : x;
    if (!pay || pay <= 1) continue; // 1.00× only when its payout is set
    const p = prob(x), avg = 1 / p;
    const hit = new Uint8Array(n), pref = new Int32Array(n + 1), last = new Int32Array(n);
    let lh = -1;
    for (let i = 0; i < n; i++) {
      hit[i] = isHit(rates[i], x) ? 1 : 0;
      pref[i + 1] = pref[i] + hit[i];
      if (hit[i]) lh = i;
      last[i] = lh;
    }
    const T = { hit, pref, last, n, since0: last[n - 1] < 0 ? n : n - 1 - last[n - 1], count0: pref[n] - pref[n - w] };
    const adjNow = avg * clamp(T.count0 / w / p, 0.25, 4);
    const triggers = [...new Set([0, (rowPct[x] ?? 95) / 100, 0.8, 1.2])];
    for (const f of triggers) for (const len of [1, 2, 3]) for (const plan of ['flat', 'step', 'recovery', 'every']) {
      const want = Math.max(1, Math.round(len * avg));
      const stakes = fitBudget(stakesFor(plan === 'every' ? 'flat' : plan, b, want, pay), budget);
      if (!stakes.length) continue; // even one stake exceeds the budget
      const key = [x, f, stakes.length, plan].join('|');
      if (seen.has(key)) continue; // longer lengths cut to the same size by the budget
      seen.add(key);
      const R = { x, pay, p, avg, f, len, plan, every: plan === 'every', stakes };
      const ev = evaluate(R, T, H, w, sims, budget);
      const firstStart = f ? Math.max(0, Math.ceil(f * adjNow - T.since0)) : 0;
      cands.push({ ...R, ...ev, cut: stakes.length < want, firstStart, adjNow, since0: T.since0 });
    }
  }
  const score = GOALS[goal] || GOALS.balanced;
  cands.forEach((c) => (c.score = score(c)));
  cands.sort((a, b2) => b2.score - a.score);
  // Top 5, preferring one plan per target so the picks are not five versions of one idea.
  const list = [], used = new Set();
  for (const c of cands) if (list.length < 5 && Number.isFinite(c.score) && !used.has(c.x)) { list.push(c); used.add(c.x); }
  for (const c of cands) if (list.length < 5 && Number.isFinite(c.score) && !list.includes(c)) list.push(c);
  self.postMessage({ at, list, tried: cands.length, ms: Math.round(performance.now() - t0), window: w, period: H });
};
