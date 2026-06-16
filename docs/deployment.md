# Local Development

Run the full stack locally without touching the deployed backend.

The Vite dev server proxies `/api` and `/ws` to `localhost:3000` by default, so no frontend config is needed — just start the backend on port 3000.

---

## Start both servers

```bash
# Terminal 1 — backend
cd BlackPearl_WS
npm install
node server.js              # serves on :3000

# Terminal 2 — frontend
cd BP_dashboard_FE
npm install
npm run dev                 # serves on :5173, proxies /api and /ws
```

Open `http://localhost:5173`.

---

## Simulate vehicle telemetry

Without a real MCU connected, use the included generator:

```bash
# Terminal 3
cd BlackPearl_WS/datagen
python datagen.py
```

`datagen.py` simulates an FSAE vehicle (skidpad / endurance modes) and publishes ~23 synthetic messages per cycle to the local WS endpoint.

---

## Environment variables

Backend `.env` (in `BlackPearl_WS/`):

```env
PORT=3000
DATABASE_URL=postgres://admin:1234@localhost/bp_db
FRONTEND_URL=http://localhost:5173
FRONTEND_DEPLOY_URL=https://blackpearl-dash.netlify.app/
PUBLISH_INTERVAL=200
```

- `PUBLISH_INTERVAL` (ms) — per-client throttle for dashboard broadcasts
- `DB_FLUSH_INTERVAL_MS` — hardcoded to 1000 ms (batch write cadence)
