# Crash Live Analysis

Real-time BC.Game Crash history with the same "Analysis" view as the in-game panel, plus extra stats.

```
npm start          # then open http://localhost:3000
```

No dependencies — Node 20.12+ only.

## How it works

- The server polls `https://bc.game/api/game/bet/multi/history` every 2 s. That endpoint only returns the latest 100 rounds.
- Older rounds are rebuilt from BC.Game's provably-fair hash chain: `previous hash = sha256(hash)`, and
  `crash = max(1, floor(99 / (1 - X)) / 100)` where `X` is the first 52 bits of `HMAC-SHA256(key = salt, msg = hash)`.
  The server checks every derived result against the API and that each new round chains into the previous one.
- The browser receives the history, live rounds, connection status and the number of people online over
  Server-Sent Events (`/events`). Visitors are counted by an anonymous per-browser id, so several tabs count once.
- Round times: every real time the server sees is saved to `data/times.json` and reused after restarts.
  Older rounds rebuilt from the hash chain have no time.
- Strategy plans are built in a Web Worker (`public/strategy-worker.js`) after every round.

## Pages

- `/` — the dashboard. First-time visitors see a short notice (analysis only, not a bot, no account or connection).
- `/docs` — the guide: data source and verification, every number and panel, alerts, privacy, FAQ, contact.

## Site details

Contact and donation details live in one place, the `SITE` object near the end of `public/app.js`
(Telegram handle, USDT BEP20 and TRC20 addresses, suggested amounts). The Telegram link also appears in
`public/index.html` and `public/docs.html`.

## Settings (`.env` or environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` | — | Proxy used to reach BC.Game (`http://user:pass@host:port`) |
| `PORT` | `3000` | Web server port |
| `HOST` | `0.0.0.0` | Interface to listen on (`0.0.0.0` = all, so other devices on the network can connect; `127.0.0.1` = this computer only) |
| `POLL_MS` | `2000` | Poll interval |
| `DEPTH` | `50000` | Rounds kept (and available for "Last N") |
| `BC_HOSTS` | `bc.game,bc.co,bc.fun,bcgame.top,bc.app` | Mirror domains, tried in order |

## Endpoints

- `/api/history?limit=2000` — JSON `{ id, rate, hash, endTime }`, newest first
- `/api/history.csv` — CSV export
