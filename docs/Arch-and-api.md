## Architecture

```
Vehicle MCU
    │  WebSocket (device)
    ▼
BlackPearl_WS (Node.js)
    │  normalize + scale (utils/dataProcessor.js)
    ├─── WS broadcast (throttled + backpressure) ──► BP_dashboard_FE (live view)
    │                                                ▲
    │                                    30s ping/pong heartbeat
    │                                    evicts dead clients
    │
    └─── bulkCreate (1s batch, guarded) ──► PostgreSQL (pool: max 10)
                                              │
                                   GET /api/session/:id/data?normalized=true
                                   (paginated 10k rows/page from frontend)
                                              │
                                              ▼
                                        BP_dashboard_FE (history playback)
```

### Connection & flow safeguards

- **Per-client backpressure:** broadcast skips clients whose `bufferedAmount` exceeds 64 KB and increments a `_droppedFrames` counter. Slow dashboards cannot queue unbounded frames.
- **Heartbeat:** every 30 s the server pings all dashboard clients; no pong → `terminate()` and eviction, with the drop count logged.
- **Flush guard:** the 1 s DB flush interval skips a tick if the previous `bulkCreate` hasn't finished, preventing pool exhaustion and silent data loss.
- **Parallel DB ops:** `Stat.bulkCreate` and `Session.increment` run via `Promise.all` within a flush (halves per-flush DB time).
- **Sequelize pool:** `max: 10, min: 2` (default 5) — headroom for concurrent flush + history reads + two dashboards.

# REST API Reference

Base URL:
- **Dev:** relative (proxied by Vite)
- **Prod:** `https://blackpearl-ws-8z9a.onrender.com`

Two route groups: `/api/session/*` for recording control, `/api/stat/*` for raw telemetry records.

---

## Session

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST   | `/api/session/start` | Begin recording — sets `activeSession` in-memory |
| POST   | `/api/session/stop`  | Stop recording — flushes DB buffer, clears `activeSession` |
| GET    | `/api/session/active` | Get currently recording session |
| GET    | `/api/session/list`   | Paginated session list |
| GET    | `/api/session/:id/data?normalized=true` | History data, pre-normalized |
| PATCH  | `/api/session/:id/rename` | Rename session (syncs `activeSession` if live) |
| DELETE | `/api/session/:id` | Delete session + its stats |
| DELETE | `/api/session/delete-unnamed` | Delete sessions with null name |
| DELETE | `/api/session/delete-all` | Nuke all sessions + stats |

### `?normalized=true` flag

When set on `/api/session/:id/data`, the backend runs each DB record through `normalizeStatRecord()` before responding — the same flatten + scale pipeline as live WS data.

Frontend receives identical shape in both live and history paths, so chart/table components don't need to branch.

---

## Stats

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET    | `/api/stat/` | Fetch all stats (optional `?since=ISO`) |
| DELETE | `/api/stat/delete` | Delete by session_name (body: `{session_name}`) |
| DELETE | `/api/stat/delete-unnamed` | Delete stats with null session_name |
| DELETE | `/api/stat/delete-all` | Delete all stats |
