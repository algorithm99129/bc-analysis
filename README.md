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
- The browser receives the history and live rounds over Server-Sent Events (`/events`).
- Round times: every real time the server sees is saved to `data/times.json` and reused after restarts.
  Older rounds get an estimated time (shown with `≈`): each round takes a fixed pause (~12.3 s, re-measured
  from the saved times) plus its flight time `ln(crash) ÷ 0.00006` ms, counted back from the nearest real time
  and stretched to fit between two real times. Keep the server running and more rounds get exact times.

## Settings (`.env` or environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` | — | Proxy used to reach BC.Game (`http://user:pass@host:port`) |
| `PORT` | `3000` | Web server port |
| `POLL_MS` | `2000` | Poll interval |
| `DEPTH` | `50000` | Rounds kept (and available for "Last N") |
| `BC_HOSTS` | `bc.game,bc.co,bc.fun,bcgame.top,bc.app` | Mirror domains, tried in order |

## Endpoints

- `/api/history?limit=2000` — JSON `{ id, rate, hash, endTime }`, newest first
- `/api/history.csv` — CSV export
