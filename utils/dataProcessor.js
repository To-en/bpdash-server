// Server-side normalization — same logic as frontend dataProcessor.js
// Pre-processes telemetry before WS broadcast so frontend skips normalizeData()

const SCALE_CONFIG = {
    V_MODULE: { scale: 0.02, offset: 0 },
    V_CELL: { scale: 0.02, offset: 0 },
    TEMP_SENSE: { scale: 0.5, offset: -40 },
    DV: { scale: 0.1, offset: 0 },
};

const applyScaling = (key, value) => {
    const baseKey = key.split('.').pop().replace(/\[\d+\]$/, '');
    const config = SCALE_CONFIG[baseKey];
    if (!config) return value;
    if (Array.isArray(value)) {
        return value.map(v => typeof v === 'number' ? v * config.scale + config.offset : v);
    }
    if (typeof value === 'number') {
        return value * config.scale + config.offset;
    }
    return value;
};

const flattenObject = (obj, prefix = "", res = {}) => {
    for (const key in obj) {
        const value = obj[key];
        const newKey = prefix ? `${prefix}.${key}` : key;

        if (Array.isArray(value)) {
            value.forEach((val, idx) => {
                const indexedKey = `${newKey}.${idx}`;
                res[indexedKey] = applyScaling(key, val);
            });
        } else if (value !== null && typeof value === "object") {
            flattenObject(value, newKey, res);
        } else {
            res[newKey] = applyScaling(key, value);
        }
    }
    return res;
};

// Normalize a raw telemetry message into the flat format the frontend expects (live WS path)
export const normalizeTelemetry = (statData, id, sessionId, sessionName, createdAt) => {
    const payload = statData.values || {};
    const flatPayload = flattenObject(payload);

    return {
        id,
        session_id: sessionId,
        session_name: sessionName,
        timestamp: statData.timestamp,
        createdAt,
        group: statData.group,
        ...flatPayload
    };
};

// Sanitize timestamp — if session-relative or missing, fall back to createdAt
const sanitizeTimestamp = (raw, createdAt) => {
    if (raw && raw > 1e12) return raw;
    return new Date(createdAt).getTime();
};

// Normalize a full DB Stat record (history playback path)
export const normalizeStatRecord = (item) => {
    const d = item.data;

    if (d?.type === 'data' && d?.group) {
        const payload = d.values || d.d || {};
        const flatPayload = flattenObject(payload);
        return {
            id: item.id,
            session_id: item.session_id,
            session_name: item.session_name,
            timestamp: sanitizeTimestamp(d.timestamp, item.createdAt),
            createdAt: item.createdAt,
            group: d.group,
            ...flatPayload
        };
    }

    // Legacy topic-based format
    const rawTs = d?.data?.timestamp ?? d?.timestamp;
    const payload = d?.data ?? {};
    const flatPayload = flattenObject(payload);
    return {
        id: item.id,
        session_id: d?.session_id,
        experiment_id: d?.experiment_id,
        topic_name: d?.topic_name || d?.topic,
        timestamp: sanitizeTimestamp(rawTs, item.createdAt),
        createdAt: item.createdAt,
        original: item,
        ...flatPayload
    };
};
