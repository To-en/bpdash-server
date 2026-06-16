# Data Pipeline

How a device message becomes a normalized broadcast and a DB row.

```
Device WS frame
    │
    ▼
utils/dataProcessor.js
    ├─ flatten nested arrays (V_CELL[0] → V_CELL.0)
    ├─ apply SCALE_CONFIG (raw int → physical units)
    └─ attach session_id / session_name if recording
    │
    ├──► WS broadcast to dashboards (throttled per client)
    │
    └──► in-memory buffer ── flush every 1s ──► Stat.bulkCreate()
```

---

## DB Write Strategy

- **No active session:** WS messages broadcast only, zero DB writes
- **Active session:** messages buffered in memory, flushed via `Stat.bulkCreate()` every **1 second**
- **On session stop:** buffer is flushed immediately before clearing `activeSession`

Batch writes keep Postgres insert volume manageable even at hundreds of messages/sec.

---

## Normalization (`utils/dataProcessor.js`)

Single source of truth for scaling. Applied server-side for both live and history paths.

```
SCALE_CONFIG:
  V_MODULE, V_CELL  → × 0.02        (raw int → Volts)
  TEMP_SENSE        → × 0.5 − 40    (raw int → °C)
  DV                → × 0.1         (raw int → Volts)
```

Two entry points share this config:

- `normalizeTelemetry()` — live WS path (called per message before broadcast)
- `normalizeStatRecord()` — history REST path (called per DB row when `?normalized=true`)

Because both go through the same pipeline, live and history data arrive at the frontend with **identical shape**. The frontend never needs to know where data came from.

# Telemetry Reliability

Two small additions to make WebSocket ingest resilient to transient network drops and
give us visibility into lost samples — without adding any external infrastructure.

## 1. Publisher-side buffering

Raw WebSocket has no replay. If the link between car and server drops for a few
seconds, those samples are gone. The fix has to live on the **publisher** (MCU /
datagen), not the server.

Each publisher holds a FIFO ring buffer of recent messages in RAM. While the WS is
up, messages are sent immediately. If a send fails, the message goes into the buffer.
On reconnect, the buffer is drained before resuming live sends.

See [`datagen/datagen.py`](../datagen/datagen.py):

- `offline_buffer` — `collections.deque(maxlen=BUFFER_MAX)`
- `send_with_buffer()` — sends or enqueues
- `flush_buffer()` — drains on reconnect

`BUFFER_MAX` is sized for ~30s at full publish rate. Bump it for longer expected
outages; bound it so a long disconnect doesn't OOM the MCU.

## 2. Per-stream sequence numbers

Every outgoing message carries a monotonic `seq`, counted independently **per
group** by the publisher:

```json
{ "type": "data", "group": "rear.odom", "ts": 1776338553473, "seq": 842,
  "client_id": "datagen-sim", "d": { ... } }
```

The server tracks the last `seq` it saw per `(publisher, group)` in
`lastSeqByStream`. If the next `seq` jumps by more than 1, it logs a gap:

```
[GAP] datagen-sim::rear.odom dropped 3 msg(s) (seq 841 → 845)
```

This gives us:

- Proof that a drop happened (vs. suspecting it from a sparse chart)
- Which publisher + group was affected
- Exact count of lost samples

Publisher identity comes from the `x-client-id` WS header (falls back to remote
IP). `seq` is optional — messages without it are accepted, just not gap-checked.
That keeps old firmware working during a rolling upgrade.

## What this does NOT do

- No persistence across MCU reboot — buffer lives in RAM
- No server-side replay or ack; the server still treats ingest as best-effort
- No automatic recovery of truly dropped messages (seq just *detects* loss)

If any of those become needed, the next step is MQTT with QoS 1, or a durable queue
(Redis Streams) in front of the DB writer. Neither is warranted at current scale.
