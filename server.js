// BC.Game Crash live history server.
// Polls BC.Game for the latest crash rounds, rebuilds older rounds from the
// provably-fair hash chain, and streams everything to the browser over SSE.
'use strict';

// Load settings such as HTTP_PROXY from .env if it exists.
try { process.loadEnvFile(require('path').join(__dirname, '.env')); } catch {}

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // all network interfaces, so other devices on the network can open it
const POLL_MS = +process.env.POLL_MS || 2000;
const DEPTH = +process.env.DEPTH || 50000; // rounds kept in memory
const HOSTS = (process.env.BC_HOSTS || 'bc.game,bc.co,bc.fun,bcgame.top,bc.app').split(',');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TIMES_FILE = path.join(__dirname, 'data', 'times.json');

// ---------- provably fair ----------

// Crash point for a round: HMAC-SHA256(key = salt, msg = hash bytes),
// first 52 bits -> 99 / (1 - X), floored to 2 decimals, minimum 1.00.
function crashPoint(hash, salt) {
  const hmac = crypto.createHmac('sha256', salt).update(Buffer.from(hash, 'hex')).digest('hex');
  const r = parseInt(hmac.slice(0, 13), 16);
  const x = 99 / (1 - r / 2 ** 52);
  return Math.max(1, Math.floor(x) / 100);
}

// The previous round's hash is sha256 of the current hash's hex string.
const prevHash = (hash) => crypto.createHash('sha256').update(hash).digest('hex');

// ---------- round times ----------

// The API only reports times for the latest 100 rounds. Every real time we see is
// kept in `realTimes` (and saved to disk); other rounds get an estimate.
const realTimes = new Map(); // id -> endTime ms
try {
  for (const [id, t] of Object.entries(JSON.parse(fs.readFileSync(TIMES_FILE, 'utf8')))) realTimes.set(+id, t);
  console.log(`loaded ${realTimes.size} saved round times`);
} catch {}

let timesDirty = false;
function saveTimes() {
  if (!timesDirty) return;
  timesDirty = false;
  const lowest = games.at(-1)?.id ?? 0;
  for (const id of realTimes.keys()) if (id < lowest) realTimes.delete(id);
  try {
    fs.mkdirSync(path.dirname(TIMES_FILE), { recursive: true });
    fs.writeFileSync(TIMES_FILE + '.tmp', JSON.stringify(Object.fromEntries(realTimes)));
    fs.renameSync(TIMES_FILE + '.tmp', TIMES_FILE);
  } catch (e) {
    console.error('could not save round times:', e.message);
  }
}
setInterval(saveTimes, 10000);

function recordTimes(latest) {
  for (const g of latest) if (g.t && realTimes.get(g.id) !== g.t) { realTimes.set(g.id, g.t); timesDirty = true; }
}

// A round's multiplier grows as e^(0.00006 · ms), so its flight lasts ln(rate) / 0.00006 ms.
// Round-to-round time = a fixed pause (betting + countdown, ~11.7 s) + that flight.
const GROWTH = 0.00006;
const flightMs = (rate) => Math.log(rate) / GROWTH;

// Long-run average pause, measured across every span between rounds with real times:
// (elapsed time − flight time) ÷ rounds. Includes the occasional longer breaks, which
// the last 100 rounds alone under-count, so it needs a few thousand rounds of coverage.
const DEFAULT_PAUSE = +process.env.DEFAULT_PAUSE_MS || 12300; // measured over ~76 h of real round times (Oct 2026)
function calibratePause() {
  let elapsed = 0, flights = 0, rounds = 0, prev = -1;
  for (let i = 0; i < games.length; i++) {
    const t = realTimes.get(games[i].id);
    if (t == null) continue;
    if (prev >= 0) {
      for (let x = prev; x < i; x++) flights += flightMs(games[x].rate);
      elapsed += realTimes.get(games[prev].id) - t;
      rounds += i - prev;
    }
    prev = i;
  }
  return rounds >= 2000 ? (elapsed - flights) / rounds : DEFAULT_PAUSE;
}

// Real time where known; otherwise step back from the next newer round. A run of
// estimates that ends at an older real time is stretched so both ends line up.
function fillTimes() {
  const pause = calibratePause();
  let i = 0;
  while (i < games.length) {
    const known = realTimes.get(games[i].id);
    if (known != null) { games[i].t = known; games[i].est = false; i++; continue; }
    let j = i;
    while (j < games.length && !realTimes.has(games[j].id)) j++;
    for (let x = i; x < j; x++) {
      const newer = games[x - 1];
      games[x].t = newer?.t != null ? newer.t - (pause + flightMs(newer.rate)) : null;
      games[x].est = true;
    }
    if (i > 0 && j < games.length) {
      const predicted = games[j - 1].t - (pause + flightMs(games[j - 1].rate));
      const diff = realTimes.get(games[j].id) - predicted, len = j - i + 1;
      for (let x = i; x < j; x++) games[x].t += (diff * (x - i + 1)) / len;
    }
    i = j;
  }
}

// ---------- state ----------

let games = []; // newest first: { id, rate, hash, t, est }  (t = endTime ms; est = true if estimated)
let salt = null;
let activeHost = HOSTS[0];
let status = { ok: false, error: 'starting', host: activeHost, lastPoll: 0 };
const clients = new Set();

// ---------- fetching ----------

// Honour HTTPS_PROXY / HTTP_PROXY (Node's built-in fetch ignores them) by
// opening a CONNECT tunnel through the proxy and running TLS over it.
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

class TunnelAgent extends https.Agent {
  createConnection(opts, cb) {
    const proxy = new URL(PROXY);
    const headers = { Host: `${opts.host}:${opts.port}` };
    if (proxy.username) {
      headers['Proxy-Authorization'] = 'Basic ' +
        Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
    }
    http.request({ host: proxy.hostname, port: proxy.port || 80, method: 'CONNECT', path: `${opts.host}:${opts.port}`, headers, timeout: 10000 })
      .on('connect', (res, socket) => {
        if (res.statusCode !== 200) return cb(new Error(`proxy CONNECT ${res.statusCode}`));
        cb(null, tls.connect({ socket, servername: opts.servername || opts.host }));
      })
      .on('timeout', function () { this.destroy(new Error('proxy timeout')); })
      .on('error', cb)
      .end();
  }
}
const agent = PROXY ? new TunnelAgent({ keepAlive: true }) : new https.Agent({ keepAlive: true });

function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST', agent, timeout: 10000,
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
        catch { reject(new Error(`HTTP ${res.statusCode}, non-JSON response`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

async function fetchLatest() {
  const order = [activeHost, ...HOSTS.filter((h) => h !== activeHost)];
  let lastErr;
  for (const host of order) {
    try {
      const { status: code, json } = await postJson(`https://${host}/api/game/bet/multi/history`,
        { gameUrl: 'crash', page: 1, pageSize: 100 },
        {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
          Origin: `https://${host}`,
          Referer: `https://${host}/game/crash`,
        });
      if (json.code !== 0 || !json.data?.list?.length) throw new Error(json.msg || `HTTP ${code}`);
      activeHost = host;
      return json.data.list.map((g) => {
        const d = JSON.parse(g.gameDetail);
        return { id: +g.gameId, rate: +d.rate, hash: d.hash, salt: d.salt, t: d.endTime };
      });
    } catch (e) {
      lastErr = new Error(`${host}: ${e.message}`);
    }
  }
  throw lastErr;
}

// Walk the hash chain back from `from` (exclusive) until `stopId` (exclusive)
// or `count` rounds, returning newest-first.
function deriveBack(from, count, stopId = -Infinity) {
  const out = [];
  let { id, hash } = from;
  while (out.length < count && id - 1 > stopId && id > 1) {
    hash = prevHash(hash);
    id -= 1;
    out.push({ id, rate: crashPoint(hash, salt), hash, t: null });
  }
  return out;
}

function rebuild(latest) {
  salt = latest[0].salt;
  const top = latest[0];
  const chain = [{ id: top.id, rate: crashPoint(top.hash, salt), hash: top.hash, t: top.t }, ...deriveBack(top, DEPTH - 1)];
  // Sanity check derived results against what the API reported.
  const bad = latest.filter((a) => {
    const g = chain[top.id - a.id];
    return g && g.rate.toFixed(2) !== a.rate.toFixed(2);
  });
  if (bad.length) console.warn(`warning: ${bad.length} derived results differ from API`);
  games = chain;
  recordTimes(latest);
  fillTimes();
  const real = games.filter((g) => !g.est).length;
  console.log(`built history: ${games.length} rounds (#${games.at(-1).id} .. #${games[0].id}), ${real} with real times`);
  broadcast('snapshot', snapshot());
}

function update(latest) {
  const top = latest[0];
  if (!games.length || top.salt !== salt || top.id < games[0].id) return rebuild(latest);
  if (top.id === games[0].id) return;

  const known = games[0];
  const fresh = [{ id: top.id, rate: crashPoint(top.hash, salt), hash: top.hash, t: top.t }, ...deriveBack(top, Infinity, known.id)];
  // The round just before the new block must chain into what we already have.
  if (prevHash(fresh.at(-1).hash) !== known.hash) {
    console.warn('hash chain mismatch, rebuilding');
    return rebuild(latest);
  }
  recordTimes(latest);
  for (const g of fresh) { g.t = realTimes.get(g.id) ?? null; g.est = g.t == null; }
  games = fresh.concat(games).slice(0, DEPTH);
  broadcast('games', fresh.reverse().map(pack)); // oldest first
}

async function poll() {
  try {
    const latest = await fetchLatest();
    update(latest);
    status = { ok: true, error: null, host: activeHost, lastPoll: Date.now() };
  } catch (e) {
    status = { ok: false, error: e.message, host: activeHost, lastPoll: Date.now() };
    console.error('poll failed:', e.message);
  }
  broadcast('status', status);
  setTimeout(poll, POLL_MS);
}

// ---------- SSE + HTTP ----------

const pack = (g) => [g.id, g.rate, g.t == null ? null : Math.round(g.t), g.est ? 1 : 0];
const snapshot = () => ({ games: games.map(pack), salt, latestHash: games[0]?.hash ?? null });

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/history') {
    const limit = Math.min(+url.searchParams.get('limit') || 2000, games.length);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(games.slice(0, limit).map(({ id, rate, hash, t, est }) =>
      ({ id, rate, hash, endTime: t == null ? null : Math.round(t), timeEstimated: !!est }))));
  }

  if (url.pathname === '/api/history.csv') {
    const limit = Math.min(+url.searchParams.get('limit') || games.length, games.length);
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="crash-history.csv"' });
    return res.end('gameId,crash,hash,endTime,timeEstimated\n' + games.slice(0, limit)
      .map((g) => `${g.id},${g.rate.toFixed(2)},${g.hash},${g.t ? new Date(g.t).toISOString() : ''},${g.est ? 1 : 0}`).join('\n'));
  }

  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
  fs.readFile(file, (err, buf) => {
    if (err) return res.writeHead(404).end('Not found');
    // no-cache: the browser re-checks on every load, so app updates show up on a normal reload
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveTimes(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log(`BC Crash Analysis listening on ${HOST}:${PORT}`);
  console.log(`  this computer: http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(require('os').networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  network:       http://${a.address}:${PORT}`);
    }
  }
  if (PROXY) console.log(`using proxy ${new URL(PROXY).host}`);
  poll();
});
