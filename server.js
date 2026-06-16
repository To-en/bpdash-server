
import express from 'express';
import { Sequelize } from 'sequelize';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import { WebSocketServer } from 'ws';

import statRoutes from './routes/statRoutes.js';
import sessionRoutes from './routes/sessionRoutes.js';
import { activeSession, setActiveSession, setFlushDbBuffer } from './routes/sessionRoutes.js';
import { initStatModel, Stat } from './models/stat_schema.js';
import { initSessionModel, Session } from './models/session_schema.js';
import { normalizeTelemetry } from './utils/dataProcessor.js';
dotenv.config();

// Initial expressjs config , app , cors allowable origin objects
const app = express();
const allowedOrigins = [
  process.env.FRONTEND_URL,
].filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.use(cors()); // allow all
// app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const PUBLISH_INTERVAL = parseInt(process.env.PUBLISH_INTERVAL) || 200;

// Sequelize sometimes ignores dialectOptions.ssl when given a URL — appending
// ?sslmode=require makes the pg driver enforce SSL at the driver level.
// Only applied for remote (non-localhost) databases; local dev skips SSL.
const isRemoteDb = DATABASE_URL && !DATABASE_URL.includes('localhost') && !DATABASE_URL.includes('127.0.0.1');
const dbUrl = isRemoteDb && !DATABASE_URL.includes('sslmode=')
  ? `${DATABASE_URL}?sslmode=require`
  : DATABASE_URL;

// Init PostgresSQL DB schema defined in ./models/state_schema.js
// const sequelize = new Sequelize(DATABASE_URL, {
//   dialect: 'postgres',
//   logging: false,
//   dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
//   pool: { max: 10, min: 2, acquire: 30000, idle: 10000 }
// });
const sequelize = new Sequelize(dbUrl, {
  dialect: 'postgres',
  logging: false,
  pool: { max: 10, min: 2, acquire: 30000, idle: 10000 }
});

// Init table for recording Telemetry data (Each Marked with session ID)
initStatModel(sequelize);

// Init table for recording session history
initSessionModel(sequelize);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Track dashboard (frontend) clients vs device clients
const dashboardClients = new Set();

// Track per-publisher sequence numbers to detect gaps from dropped packets.
// Key: `${client_id || ip}::${group}` — one counter per publisher+group stream.
const lastSeqByStream = new Map();

// Broadcast pre-normalized telemetry to all connected dashboard clients
// Global PUBLISH_INTERVAL (from .env) — messages are dropped if sent too soon
const WS_BACKPRESSURE_LIMIT = 1024 * 64; // 64KB — drop frames if client can't keep up
const broadcastToDashboards = (message) => {
  const data = JSON.stringify(message);
  const now = Date.now();
  const group = message.group || '_default';
  for (const client of dashboardClients) {
    if (client.readyState !== 1) continue;
    if (now - (client._lastSentPerGroup[group] || 0) < PUBLISH_INTERVAL) continue;
    // Backpressure: skip client if its send buffer is backed up
    if (client.bufferedAmount > WS_BACKPRESSURE_LIMIT) {
      client._droppedFrames = (client._droppedFrames || 0) + 1;
      continue;
    }
    client._lastSentPerGroup[group] = now;
    client.send(data);
  }
};

// --- Batch DB write buffer if record button pressed ---
let dbWriteBuffer = [];
const DB_FLUSH_INTERVAL_MS = 1000;
let flushInProgress = false;

const flushDbBuffer = async () => {
  if (dbWriteBuffer.length === 0) return;

  // Guard: skip if previous flush hasn't finished (prevents pool exhaustion)
  if (flushInProgress) {
    console.warn(`[DB] Flush skipped — previous write still in progress (${dbWriteBuffer.length} buffered)`);
    return;
  }

  flushInProgress = true;
  const batch = dbWriteBuffer.splice(0);
  const sessionId = batch[0].session_id;
  try {
    // Run insert and counter update in parallel — one round-trip instead of two
    await Promise.all([
      Stat.bulkCreate(batch),
      Session.increment('data_point_count', {
        by: batch.length,
        where: { session_id: sessionId }
      })
    ]);
  } catch (err) {
    console.error(`[DB] Batch write error (${batch.length} rows lost):`, err.message);
  } finally {
    flushInProgress = false;
  }
};

// Set flush interval
setInterval(flushDbBuffer, DB_FLUSH_INTERVAL_MS);
setFlushDbBuffer(flushDbBuffer);

// Heartbeat: ping dashboard clients every 30s, terminate if no pong
const HEARTBEAT_INTERVAL_MS = 30_000;
setInterval(() => {
  for (const client of dashboardClients) {
    if (!client.isAlive) {
      console.log(`[DASHBOARD] Dead client evicted (no pong). Dropped frames: ${client._droppedFrames || 0}`);
      dashboardClients.delete(client);
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, HEARTBEAT_INTERVAL_MS);


// --- Connection Handling ---
wss.on("connection", (ws, req) => {
  // Dashboard clients connect with ?role=dashboard
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role');

  if (role === 'dashboard') {
    ws._lastSentPerGroup = {};
    ws._droppedFrames = 0;
    dashboardClients.add(ws);
    console.log(`[DASHBOARD] Client connected (${dashboardClients.size} total), publish rate: ${PUBLISH_INTERVAL}ms`);

    // TODO: scaffold for future auth-gated publish rate override
    // ws.on('message', (raw) => {
    //   const msg = JSON.parse(raw.toString());
    //   if (msg.type === 'set_publish_interval' && isAuthenticated(ws, 'dev')) {
    //     // Update global or per-client rate from DB
    //   }
    // });

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on("close", () => {
      dashboardClients.delete(ws);
      console.log(`[DASHBOARD] Client disconnected (${dashboardClients.size} total)`);
    });
    return;
  }

  // Identify publisher for per-stream sequence tracking
  const publisherId = req.headers['x-client-id']
    || req.socket.remoteAddress
    || 'unknown';

  // Device client (MCU nodes)
  ws.on("message", async (raw) => {
    try {
      const payload = JSON.parse(raw.toString());

      if (payload.type === "data" && payload.group && payload.ts && payload.d) {
        const now = new Date().toISOString();
        const msgId = Date.now();
        const sessionId = activeSession?.session_id || null;
        const sessionName = activeSession?.name || null;

        // If firmware sends a node field, prepend it to the group: "faults" + node="front" → "front.faults"
        const resolvedGroup = payload.node
          ? `${payload.node}.${payload.group}`
          : payload.group;

        // Detect gaps: if seq provided, compare against last seen for this publisher+group.
        // Missing seq is logged (firmware should upgrade), but message still accepted.
        let gap = 0;
        if (typeof payload.seq === 'number') {
          const streamKey = `${publisherId}::${resolvedGroup}`;
          const prevSeq = lastSeqByStream.get(streamKey);
          if (prevSeq !== undefined && payload.seq > prevSeq + 1) {
            gap = payload.seq - prevSeq - 1;
            console.warn(`[GAP] ${streamKey} dropped ${gap} msg(s) (seq ${prevSeq} → ${payload.seq})`);
          }
          lastSeqByStream.set(streamKey, payload.seq);
        }

        // Build raw data object (stored in DB as-is)
        const statData = {
          type: payload.type,
          group: resolvedGroup,
          timestamp: payload.ts,
          seq: payload.seq,
          values: payload.d,
          receivedAt: now
        };

        // Pre-normalize for dashboard (frontend skips normalizeData for live)
        const normalized = normalizeTelemetry(statData, msgId, sessionId, sessionName, now);
        broadcastToDashboards(normalized);

        // Only buffer to DB when a session is recording
        if (activeSession) {
          dbWriteBuffer.push({
            session_id: activeSession.session_id,
            session_name: activeSession.name,
            data: statData
          });
        }

        ws.send(JSON.stringify({
          type: "registration_response",
          status: "accepted",
          system_time: { timestamp_ms: Date.now() }
        }));
      } else if (payload.type === "register") {
        if (payload.groups && payload.schema) {
          console.log(`[REGISTRATION] Client: ${payload.client_name}, Groups: ${payload.groups.map(g => g.group).join(', ')}`);
        }

        ws.send(JSON.stringify({
          type: "registration_response",
          status: "accepted",
          system_time: { timestamp_ms: Date.now() }
        }));
      } else {
        ws.send(JSON.stringify({
          status: "error",
          message: "Invalid message format",
          ts: Date.now()
        }));
      }
    } catch (error) {
      console.error("WebSocket message error:", error);
      ws.send(JSON.stringify({
        status: "error",
        message: error.message,
        ts: Date.now()
      }));
    }
  });
});

// Route to /api/stat to poll for
app.use('/api/stat', statRoutes);
app.use('/api/session', sessionRoutes);
app.get('/api/config', (req, res) => res.json({ publishInterval: PUBLISH_INTERVAL }));
app.get('/', (req, res) => res.json({ status: 'ok' }));

(async () => {
  await sequelize.authenticate();
  // await sequelize.sync({ alter: true });
    // -- uncomment for local dev

  // Sync active session on startup
  const activeSessionRecord = await Session.findOne({
    where: { status: 'recording' }
  });
  if (activeSessionRecord) {
    setActiveSession({
      session_id: activeSessionRecord.session_id,
      name: activeSessionRecord.name,
      start_time: activeSessionRecord.start_time
    });
    console.log(`[SESSION] Restored active session: ${activeSessionRecord.session_id}`);
  }

  server.listen(PORT, () => console.log(`running on http://localhost:${PORT}`));
})();
