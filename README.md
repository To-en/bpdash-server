# BlackPearl Dashboard (BP16B) — Backend

Real-time telemetry bridge for the BP16B Formula Student Electric car. Receives sensor data from on-car MCUs over WebSocket, normalizes and scales it server-side, broadcasts to any connected dashboard, and records sessions to PostgreSQL.

<p align="center">
  <a href="doc/websocket-protocol.md">WebSocket Protocol</a> ·
  <a href="doc/api-reference.md">REST API</a> ·
  <a href="doc/data-pipeline.md">Data Pipeline</a> ·
  <a href="doc/local-development.md">Local Development</a> ·
  <a href="../BP_dashboard_FE">Frontend repo</a>
</p>

---

## Architecture

```
Vehicle MCU
    │  WebSocket (device)
    ▼
BlackPearl_WS (Node.js)
    │  normalize + scale (utils/dataProcessor.js)
    ├─── WS broadcast ──────────────────► BP_dashboard_FE (live view)
    └─── bulkCreate (1s batch) ────────► PostgreSQL
                                              │
                                   GET /api/session/:id/data?normalized=true
                                              │
                                              ▼
                                        BP_dashboard_FE (history playback)
```

Backend sends **pre-normalized, pre-scaled flat objects**. The frontend has no scaling logic — live and history data arrive in the same shape.

## Features

| Live streaming | Recording | Storage |
|---|---|---|
| [WS broadcast](doc/websocket-protocol.md) of normalized telemetry | [Session lifecycle](doc/api-reference.md#session) (start / stop / rename) | [Batched writes](doc/data-pipeline.md) — 1 s flush interval |
| Per-client throttle (`PUBLISH_INTERVAL`) | Zero-write mode when no active session | PostgreSQL with JSONB payload |
| Auto-reconnect handshake | History replay via REST | Pre-normalization on read (`?normalized=true`) |

## Tech Stack

- **Node.js** + **Express 4** — HTTP / REST
- **ws** — WebSocket server
- **Sequelize** + **PostgreSQL** — session & stats storage (JSONB)
- **dotenv** — config
- `datagen/datagen.py` — synthetic FSAE telemetry generator for local dev

## Project Structure
```
BlackPearl_WS/
├── server.js               # Express + WS entry point, broadcast loop, buffer flush
├── routes/                 # REST routers (session, stat)
├── models/                 # Sequelize schemas (Session, Stat)
├── utils/dataProcessor.js  # Normalize + scale (single source of truth)
├── datagen/                # Python synthetic-data generator
└── doc/                    # Deep-dive documentation
```

## Quick Start

Requires Node 18+ and a running PostgreSQL instance.

Development:
1. Create your own `.env` (copy and modify from `.env.example`)
2. Type
```bash
npm install
npm run start   # serves on port 3000
# OR
npm run dev     # For real-time change
```

## API at a glance

Full reference in [docs/api-reference.md](docs/api-reference.md).

| Group | Typical calls |
|---|---|
| `/api/session` | `start`, `stop`, `active`, `list`, `:id/data`, `:id/rename`, `:id` (delete) |
| `/api/stat`    | `GET /`, `delete`, `delete-unnamed`, `delete-all` |
| `/ws`          | Device (no role) & dashboard (`?role=dashboard`) endpoints |

---

## Learn More

- [Architecture and API reference](/docs/Arch-and-api.md) - WebSocket stream, API Route,  
- [How data flow from vehicle to the server](/docs/data-flow.md) -- dataprocessing logic 
- [Theming](doc) — Tailwind v4 CSS variables and dark mode
- [Sensor Naming](doc/sensor-naming.md) — raw keys → human-readable labels


## Future Work

### Authorized setting (User vs Developer account)

The frontend [SettingsPage](../BP_dashboard_FE/src/pages/SettingsPage.jsx) exposes a "Developer Settings" section for server-side knobs (currently `PUBLISH_INTERVAL`). These are read from `.env` at boot and cannot be changed at runtime.

Planned backend support:

1. **Auth layer** — lightweight middleware (token or session-based) with at least two roles: `user` and `dev`.
2. **Config endpoints**:
   - `GET  /api/config` — return live values (`publishInterval`, `dbFlushInterval`, scale configs)
   - `PATCH /api/config` — update values, dev-role only
3. **Persistence** — store config in a new `settings` table so changes survive restarts and sync across all connected dashboards. On boot, load DB values and fall back to `.env` defaults.
4. **Live application** — push config changes into the running broadcast loop without requiring a restart.