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

// The API only reports times for the latest 100 rounds. Every real time we see is kept in
// `realTimes` and saved to disk, so rounds seen live keep their time across restarts.
// Older rounds rebuilt from the hash chain have no time.
const realTimes = new Map(); // id -> endTime ms
try {
  for (const [id, t] of Object.entries(JSON.parse(fs.readFileSync(TIMES_FILE, 'utf8')))) realTimes.set(+id, t);
  console.log(`loaded ${realTimes.size} saved round times`);
} catch {}

let timesDirty = false, saveFailing = false;
function saveTimes() {
  if (!timesDirty) return;
  const lowest = games.at(-1)?.id ?? 0;
  for (const id of realTimes.keys()) if (id < lowest) realTimes.delete(id);
  const data = JSON.stringify(Object.fromEntries(realTimes));
  try {
    fs.mkdirSync(path.dirname(TIMES_FILE), { recursive: true });
    try {
      fs.writeFileSync(TIMES_FILE + '.tmp', data);
      fs.renameSync(TIMES_FILE + '.tmp', TIMES_FILE); // atomic replace
    } catch (e) {
      // Windows refuses the replace while something holds the file open (another copy of the
      // server, an editor, antivirus). Write it in place instead.
      if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      fs.writeFileSync(TIMES_FILE, data);
      try { fs.unlinkSync(TIMES_FILE + '.tmp'); } catch {}
    }
    timesDirty = false;
    if (saveFailing) console.log('round times saved again');
    saveFailing = false;
  } catch (e) {
    // Keep the data and retry on the next interval; say so once, not every 10 seconds.
    if (!saveFailing) console.error(`could not save round times (${e.code || e.message}); will keep retrying. Is another copy of the server running?`);
    saveFailing = true;
  }
}
setInterval(saveTimes, 10000);

function recordTimes(latest) {
  for (const g of latest) if (g.t && realTimes.get(g.id) !== g.t) { realTimes.set(g.id, g.t); timesDirty = true; }
}

// ---------- state ----------

let games = []; // newest first: { id, rate, hash, t }  (t = endTime ms, null if not seen live)
let salt = null;
let activeHost = HOSTS[0];
// state: 'connecting' (no data yet) | 'ok' | 'error' (last poll failed; retrying)
let status = { ok: false, state: 'connecting', error: null, host: activeHost, lastPoll: 0, failures: 0, proxy: false, retryMs: 0 };
const clients = new Set();
const viewers = new Map(); // SSE response -> visitor id (one per browser, so several tabs count once)

// People online = distinct visitor ids with the page open. Sent to everyone when it changes.
let presenceTimer = null;
const online = () => new Set(viewers.values()).size;
function schedulePresence() {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => broadcast('presence', { online: online() }), 400); // one update per burst
}

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
    if (!games.length) { status = { ...status, host }; broadcast('status', status); } // show progress while loading
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
  for (const g of games) g.t = realTimes.get(g.id) ?? null;
  const real = games.filter((g) => g.t != null).length;
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
  for (const g of fresh) g.t = realTimes.get(g.id) ?? null;
  games = fresh.concat(games).slice(0, DEPTH);
  broadcast('games', fresh.reverse().map(pack)); // oldest first
}

async function poll() {
  try {
    const latest = await fetchLatest();
    update(latest);
    status = { ok: true, state: 'ok', error: null, host: activeHost, lastPoll: Date.now(), failures: 0, proxy: !!PROXY, retryMs: 0 };
  } catch (e) {
    status = { ok: false, state: 'error', error: e.message, host: activeHost, lastPoll: Date.now(),
      failures: status.failures + 1, proxy: !!PROXY, retryMs: POLL_MS };
    console.error('poll failed:', e.message);
  }
  broadcast('status', status);
  setTimeout(poll, POLL_MS);
}

// ---------- SSE + HTTP ----------

const pack = (g) => [g.id, g.rate, g.t];
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
    const cid = url.searchParams.get('cid');
    viewers.set(res, /^[A-Za-z0-9-]{8,64}$/.test(cid || '') ? cid : crypto.randomUUID());
    res.write(`event: presence\ndata: ${JSON.stringify({ online: online() })}\n\n`);
    schedulePresence();
    req.on('close', () => { clients.delete(res); viewers.delete(res); schedulePresence(); });
    return;
  }

  if (url.pathname === '/api/history') {
    const limit = Math.min(+url.searchParams.get('limit') || 2000, games.length);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(games.slice(0, limit).map(({ id, rate, hash, t }) => ({ id, rate, hash, endTime: t }))));
  }

  if (url.pathname === '/api/history.csv') {
    const limit = Math.min(+url.searchParams.get('limit') || games.length, games.length);
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="crash-history.csv"' });
    return res.end('gameId,crash,hash,endTime\n' + games.slice(0, limit)
      .map((g) => `${g.id},${g.rate.toFixed(2)},${g.hash},${g.t ? new Date(g.t).toISOString() : ''}`).join('\n'));
  }

  const page = { '/': 'index.html', '/docs': 'docs.html', '/docs/': 'docs.html' }[url.pathname] || url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, page));
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
