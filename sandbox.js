// Sandbox crash game: the server's own continuous, shared crash rounds for play money.
//
// Provably fair the same way BC.Game is: a chain of L hashes is generated up front from a
// random seed (s[i+1] = sha256(s[i])) and played backwards, so each round's previous round
// is sha256(its hash). The hash after the last one, sha256(s[L-1]), is published as the
// commitment before any round is played; each round's hash is revealed when it crashes.
// Results use the same formula and the same flight speed as the real game.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { crashPoint, prevHash, GROWTH } = require('./crash');

const L = 1_000_000;        // rounds per chain (~10 months at ~25 s a round)
const STEP = 1000;          // keep every 1000th hash so any round's hash is ≤ 999 hashes away
const PREPLAYED = 50_000;   // rounds treated as already played, so the analysis has history at once
const BET_MS = 7000;        // betting countdown
const AFTER_MS = 3000;      // pause after a crash

function createSandbox({ file, depth, broadcast }) {
  let st = load() || newChain();
  let cur = null;           // the round being bet on / flown
  let history = [];         // newest first: [id, rate, endTime|null]

  function load() {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (s.L === L && Array.isArray(s.cps) && s.kNext > 0) return s;
    } catch {}
    return null;
  }

  function newChain() {
    const t0 = Date.now();
    const seed = crypto.randomBytes(32).toString('hex');
    const cps = [];
    let h = seed;
    for (let i = 0; i < L; i++) {
      if (i % STEP === 0) cps.push(h);
      if (i < L - 1) h = prevHash(h);
    }
    const s = {
      L, cps, kNext: L - 1 - PREPLAYED,
      salt: crypto.randomBytes(32).toString('hex'),
      commit: prevHash(h), // sha256 of the first-played hash s[L-1]
      createdAt: Date.now(),
    };
    console.log(`sandbox: new hash chain in ${Date.now() - t0} ms, commitment ${s.commit.slice(0, 16)}…`);
    save(s);
    return s;
  }

  function save(s = st) {
    const data = JSON.stringify(s);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { fs.writeFileSync(file + '.tmp', data); fs.renameSync(file + '.tmp', file); }
      catch { fs.writeFileSync(file, data); } // Windows may refuse the replace while the file is open
    } catch (e) { console.error('sandbox: could not save state:', e.code || e.message); }
  }

  // s[k], from the nearest stored hash at or below k.
  function hashAt(k) {
    let h = st.cps[Math.floor(k / STEP)];
    for (let i = Math.floor(k / STEP) * STEP; i < k; i++) h = prevHash(h);
    return h;
  }
  const idOf = (k) => L - k; // first-played s[L-1] is round 1

  // History of played rounds: walk back from the newest played hash (like the real game).
  function rebuildHistory() {
    const kLast = st.kNext + 1;
    let h = hashAt(kLast);
    const out = [];
    for (let k = kLast; k < L && out.length < depth; k++) {
      out.push([idOf(k), crashPoint(h, st.salt), null]);
      h = prevHash(h);
    }
    history = out;
  }

  function publicState() {
    const s = { phase: cur.phase, id: cur.id, now: Date.now(), salt: st.salt, commit: st.commit };
    if (cur.phase === 'betting') s.bettingEndsAt = cur.bettingEndsAt;
    if (cur.phase !== 'betting') s.startAt = cur.startAt;
    if (cur.phase === 'crashed') Object.assign(s, { rate: cur.rate, hash: cur.hash, endAt: cur.endAt });
    return s; // the result and hash stay secret until the round crashes
  }
  const emit = () => broadcast('sbx', publicState());

  function nextRound() {
    if (st.kNext < 0) { st = newChain(); rebuildHistory(); } // chain used up: start a new one
    const k = st.kNext, hash = hashAt(k);
    cur = { id: idOf(k), k, hash, rate: crashPoint(hash, st.salt), phase: 'betting', bettingEndsAt: Date.now() + BET_MS };
    emit();
    setTimeout(fly, BET_MS);
  }

  function fly() {
    cur.phase = 'running';
    cur.startAt = Date.now();
    emit();
    setTimeout(crash, Math.log(cur.rate) / GROWTH); // e^(GROWTH·t) reaches the crash point
  }

  function crash() {
    cur.phase = 'crashed';
    cur.endAt = Date.now();
    emit();
    const row = [cur.id, cur.rate, cur.endAt];
    history.unshift(row);
    if (history.length > depth) history.length = depth;
    st.kNext = cur.k - 1;
    save();
    broadcast('sbx-round', row);
    setTimeout(nextRound, AFTER_MS);
  }

  return {
    start() { rebuildHistory(); nextRound(); console.log(`sandbox: ${history.length} rounds of history, next round #${idOf(st.kNext)}`); },
    state: () => (cur ? publicState() : null),
    history: (limit) => ({ games: history.slice(0, limit), salt: st.salt, commit: st.commit }),
  };
}

module.exports = { createSandbox };
