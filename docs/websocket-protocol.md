# WebSocket Protocol

The backend exposes a single WebSocket endpoint. Two client roles connect to it:

| Role | Query | Purpose |
|---|---|---|
| Device (MCU) | `/ws` (no `role`) | Vehicle nodes push raw telemetry up |
| Dashboard | `/ws?role=dashboard` | Frontend clients receive normalized broadcasts |

The backend runs every incoming device message through `utils/dataProcessor.js` and broadcasts the flattened, pre-scaled result to all dashboard clients.

---

## Dashboard payload shape

What a dashboard client receives per message — a flat object ready to render:

```json
{
  "id": 1710000000000,
  "session_id": "uuid-or-null",
  "session_name": "run_01-or-null",
  "timestamp": 1773465819178,
  "createdAt": "2026-03-14T05:23:39.225Z",
  "group": "bmu6.cells",
  "V_CELL.0": 3.78,
  "V_CELL.1": 3.76,
  "TEMP_SENSE.0": -23.0,
  "V_MODULE": 37.76,
  "DV": 0.1,
  "connected": true
}
```

- `group` — origin topic (`bmu0.cells`, `front.mech`, …)
- `timestamp` — device-provided ms epoch
- `createdAt` — server-side receive time
- `session_*` — populated only while a recording session is active
- Remaining keys — flattened sensor values, already in physical units

Arrays are flattened with dotted indices (`V_CELL[0]` → `V_CELL.0`). Scalar sensors keep their original key.

---

## Connection behavior

- **URL (dev):** `ws://<host>/ws?role=dashboard` (proxied by Vite → `localhost:3000`)
- **URL (prod):** `wss://blackpearl-ws-8z9a.onrender.com/ws?role=dashboard`
- **Reconnect:** frontend auto-reconnects every 2 s on disconnect (`src/utils/websocket.js`)
- **Throttling:** backend throttles per-client broadcasts at `PUBLISH_INTERVAL` (default 200 ms)

---

## Frontend render loop

`src/hooks/useTelemetryStream.js` on the dashboard side:

- Buffers every WS message into a ref (no React state update per message)
- Flushes to state at a ~100 ms interval (~10 fps)
- Marks data as **STALE** if no message arrives for 10 s

This lets the dashboard handle hundreds of messages per second without re-rendering on each one.
