# TradingView Mirror — the whole project (read this first)

This zip is the complete, runnable project: the mirror app, every patch/fix, all persisted state,
the run instructions, the agent instructions, and the research notes.

## What's inside

| Path | What it is |
| --- | --- |
| `app/` | **The application.** Server, proxy, all patches, mirrored TradingView bundles, saved state. |
| `app/README-run.md` | Detailed run notes + history of every fix (watchlist lock, missing chunks, paywall, …). |
| `AGENTS.md` | Instructions for any AI coding agent that opens this project (how it works, rules, next task). |
| `HANDOFF.md` | Latest status: what was fixed on Nov 7, what is server-blocked, the next task. |
| `docs/` | TradingView internals analysis, Bar Replay trace, original build plan. |
| `app/native-builtin-bridge.js`…

(actually at `app/www.tradingview.com/native-builtin-bridge.js`) | Maps dialog Pine built-ins to native study ids — the indicator fix. |

## Run it (Windows) — 3 steps

```powershell
cd app
node wsproxy.js        # terminal 1  — WebSocket proxy, port 8090 (start first)
node serve.js          # terminal 2  — app server, port 8088
```

Then open: **http://127.0.0.1:8088/www.tradingview.com/chart/j3mUKCaZ/**

Optional: `node token-keepalive.js --watch` to keep the feed auth fresh.

## Highlights

- Live TradingView feed (via local WS proxy) — no plan limits, no paywalls.
- Bar Replay works. All styles/intervals work. Watchlists (incl. >30 symbols, flag colors) work.
- Layouts / drawings / settings / watchlists persist across restarts.
- Indicators: 69 built-ins now insert as native studies through the dialog.
- Not fixable client-side: a few studies the TV server itself refuses for this free account
  (`TripleEMA`, `Envelope`). See `AGENTS.md` §6 and the next task in `HANDOFF.md` §"What remains".

## ⚠️ Security

`app/auth-token.txt`, `app/cookie-header.txt` and `app/session-cookie.txt` contain **live TradingView
session credentials** for the account that feeds the chart. Do not share, publish or upload this zip.
If the token expires, run `node token-refresh.js` (or `token-keepalive.js --watch`).

## Moving to another coding app

Point the other app/agent at this folder and tell it: *"Read AGENTS.md, then HANDOFF.md, then
continue the task in §8."* The project's memory lives in these files — no chat history is needed.
