# TV Terminal — TradingView Mirror

A local mirror of the TradingView web app that runs on your machine against the real live feed,
without plan limits or paywalls.

It is **not** a re-implementation: the UI, JS bundles and data feed are TradingView's own. All the
work here is a small Node server that rewrites/patches the client while serving it, plus a
WebSocket re-origin proxy that lets the chart talk to TradingView's real socket from `localhost`.

```
http://127.0.0.1:8088/www.tradingview.com/chart/j3mUKCaZ/
```

## What works

- Live candles (via local WS proxy), every chart style and interval.
- Bar Replay — truncates at cursor, dims future bars, play/step/speed.
- Watchlists: sections, rename/copy/clear, >30 symbols unlocked, flag colors; persisted.
- Layouts, drawings, settings and watchlists persist across restarts.
- Paywall never renders (opener no-op + row-lock disabled).
- Symbol search via the local `/__ss` proxy.
- 69 built-in studies insert as native `@tv-basicstudies` through the indicator dialog
  (via `app/www.tradingview.com/native-builtin-bridge.js`).

## Known limits

- The TradingView server itself refuses a few native studies for a non-Pro account
  (`study_limit_exceeded` → `TripleEMA`, `Envelope`, most strategies). No client patch fixes that;
  it needs a local study engine. See `HANDOFF.md`.
- Community `USER;` Pine scripts stay unsupported.
- Not proxied: `pricealerts.`, `notifications.`, `news-mediator.` (alerts/news panels show CORS errors).

## Run it (Windows)

```powershell
cd app
node wsproxy.js      # port 8090 — start first
node serve.js        # port 8088
```

Optional, keeps the feed token fresh:

```powershell
node token-keepalive.js --watch
```

Then open <http://127.0.0.1:8088/www.tradingview.com/chart/j3mUKCaZ/>.

If the chart loses its feed, `wsproxy.js` died — restart it. Check ports 8090 and 8088.

## Credentials — read this

The mirror needs a TradingView session to reach the feed. **No credentials are stored in this repo.**
`serve.js` splices a live token from `app/auth-token.txt` into the chart page at serve time; the
page's own token is blanked. Without that file the app still runs, anonymously (delayed feed).

```powershell
# capture a token from your own logged-in session, then:
node token-refresh.js        # one-shot
node token-keepalive.js --watch
```

Never commit `auth-token.txt`, `cookie-header.txt` or `session-cookie.txt` — `.gitignore` covers them.

## Layout

| Path | What it is |
| --- | --- |
| `app/serve.js` | static server, URL rewrite, patch injection, store splice (8088) |
| `app/patches.js` | all client patches: limit removals, paywall kill, bridge injection |
| `app/wsproxy.js` | WebSocket re-origin proxy (8090), logs study verdicts |
| `app/symbols-api.js` | symbol-search proxy (`/__ss`) |
| `app/token-keepalive.js`, `app/token-refresh.js` | feed auth freshness |
| `app/www.tradingview.com/native-builtin-bridge.js` | maps dialog built-ins to native study ids |
| `app/static.tradingview.com/` | mirrored JS/CSS bundles (~86 MB, required to run) |
| `docs/` | TradingView internals analysis, Bar Replay trace, build plan |
| `AGENTS.md`, `HANDOFF.md` | agent instructions and the current status/next task |

## Notice

`app/static.tradingview.com/` and the mirrored host payloads are **TradingView's proprietary
code**, redistributed here only as a local working copy, and `app/patches.js` removes paid-plan
limits. Keep this repository private; do not publish it or redistribute the bundle. Use it only
with an account you own, and in line with TradingView's terms.
