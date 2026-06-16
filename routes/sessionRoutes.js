import express from 'express';
import { Op } from 'sequelize';
import { Session } from '../models/session_schema.js';
import { Stat } from '../models/stat_schema.js';
import { v4 as uuidv4 } from 'uuid';
import { normalizeStatRecord } from '../utils/dataProcessor.js';

const router = express.Router();

// Global variable to track active session (shared with WebSocket handler)
export let activeSession = null;
export const setActiveSession = (session) => {
  activeSession = session;
};


let _flushDbBuffer = null;
/**
 * Injected flush function from server.js (called on stop to flush DB buffer)
 * @param {function} fn - function pointer.
 */
export const setFlushDbBuffer = (fn) => { _flushDbBuffer = fn; };

/**
 * POST /start
 * Start a new recording session
 */
router.post('/start', async (req, res) => {
  try {
    const { name } = req.body;

    // Check if there's already an active session from other client
    // (Allows only one client to record at a time)
    const existingActive = await Session.findOne({
      where: { status: 'recording' }
    });

    if (existingActive) {
      return res.status(400).json({
        error: 'A recording session is already active',
        active_session: {
          session_id: existingActive.session_id,
          name: existingActive.name,
          start_time: existingActive.start_time
        }
      });
    }

    // Create new session
    const session_id = uuidv4();
    const newSession = await Session.create({
      session_id,
      name: name || null,
      status: 'recording',
      start_time: new Date(),
      data_point_count: 0,
      metadata: {}
    });

    // Set as active session for WebSocket handler
    setActiveSession({
      session_id: newSession.session_id,
      name: newSession.name,
      start_time: newSession.start_time
    });

    res.json({
      session_id: newSession.session_id,
      name: newSession.name,
      start_time: newSession.start_time,
      status: newSession.status,
      data_point_count: newSession.data_point_count
    });
  } catch (err) {
    console.error('POST /api/session/start error:', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

// ------------------------- 
// Route

/**
 * POST /stop
 * Stop the active recording session
 */
router.post('/stop', async (req, res) => {
  try {
    const { session_id } = req.body;

    if (!session_id) {
      return res.status(400).json({ error: 'session_id is required' });
    }

    const session = await Session.findOne({
      where: { session_id, status: 'recording' }
    });

    if (!session) {
      return res.status(404).json({ error: 'Active session not found' });
    }

    // Update session
    const end_time = new Date();
    await session.update({
      status: 'stopped',
      end_time
    });

    // Flush any buffered DB writes before clearing session
    if (_flushDbBuffer) await _flushDbBuffer();

    // Clear active session
    setActiveSession(null);

    res.json({
      session_id: session.session_id,
      name: session.name,
      start_time: session.start_time,
      end_time: session.end_time,
      status: session.status,
      data_point_count: session.data_point_count
    });
  } catch (err) {
    console.error('POST /api/session/stop error:', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

/**
 * PATCH /:session_id/rename
 * Update session name
 */
router.patch('/:session_id/rename', async (req, res) => {
  try {
    const { session_id } = req.params;
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const session = await Session.findOne({ where: { session_id } });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await session.update({ name });

    // Sync active session name if this is the active session
    if (activeSession && activeSession.session_id === session_id) {
      activeSession.name = name;
    }

    res.json({
      session_id: session.session_id,
      name: session.name
    });
  } catch (err) {
    console.error('PATCH /api/session/:session_id/rename error:', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

/**
 * GET /active
 * Get currently recording session
 */
router.get('/active', async (req, res) => {
  try {
    const session = await Session.findOne({
      where: { status: 'recording' }
    });

    if (!session) {
      return res.json(null);
    }

    res.json({
      session_id: session.session_id,
      name: session.name,
      start_time: session.start_time,
      status: session.status,
      data_point_count: session.data_point_count
    });
  } catch (err) {
    console.error('GET /api/session/active error:', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

/**
 * GET /list
 * List all sessions (paginated)
 */
router.get('/list', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status;

    const where = {};
    if (status) {
      where.status = status;
    }

    const sessions = await Session.findAll({
      where,
      order: [['start_time', 'DESC']],
      limit,
      offset,
      attributes: [
        'session_id',
        'name',
        'start_time',
        'end_time',
        'status',
        'data_point_count',
        'createdAt'
      ]
    });

    res.json(sessions);
  } catch (err) {
    console.error('GET /api/session/list error:', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

/**
 * GET /:session_id/data
 * Get data for specific session (paginated)
 */
router.get('/:session_id/data', async (req, res) => {
  try {
    const { session_id } = req.params;
    const limit = parseInt(req.query.limit) || 1000;
    const offset = parseInt(req.query.offset) || 0;

    const normalize = req.query.normalized === 'true';

    const stats = await Stat.findAll({
      where: { session_id },
      order: [['createdAt', 'ASC']],
      limit,
      offset
    });

    res.json(normalize ? stats.map(s => normalizeStatRecord(s.toJSON())) : stats);
  } catch (err) {
    console.error('GET /api/session/:session_id/data error:', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

/**
 * DELETE /delete-unnamed
 * Delete sessions where name is null and their associated stats
 */
router.delete('/delete-unnamed', async (req, res) => {
  try {
    // Find all unnamed sessions
    const unnamedSessions = await Session.findAll({
      where: { name: null },
      attributes: ['session_id']
    });

    const sessionIds = unnamedSessions.map(s => s.session_id);

    // Delete stats for those sessions
    let deletedStatsCount = 0;
    if (sessionIds.length > 0) {
      deletedStatsCount = await Stat.destroy({
        where: { session_id: sessionIds }
      });
    }

    // Delete the unnamed sessions
    const deletedSessionCount = await Session.destroy({
      where: { name: null }
    });

    res.json({
      message: 'Unnamed sessions and associated data deleted successfully',
      deleted_stats_count: deletedStatsCount,
      deleted_session_count: deletedSessionCount
    });
  } catch (err) {
    console.error('DELETE /api/session/delete-unnamed error:', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

/**
 * DELETE /delete-all
 * Delete all sessions and all associated stats
 */
router.delete('/delete-all', async (req, res) => {
  try {
    // Delete all stats first
    const deletedStatsCount = await Stat.destroy({
      where: {},
      truncate: false
    });

    // Delete all sessions
    const deletedSessionCount = await Session.destroy({
      where: {},
      truncate: false
    });

    res.json({
      message: 'All sessions and associated data deleted successfully',
      deleted_stats_count: deletedStatsCount,
      deleted_session_count: deletedSessionCount
    });
  } catch (err) {
    console.error('DELETE /api/session/delete-all error:', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

/**
 * DELETE /:session_id
 * Delete session and all associated data
 */
router.delete('/:session_id', async (req, res) => {
  try {
    const { session_id } = req.params;

    // Delete all stats associated with this session
    const deletedStatsCount = await Stat.destroy({
      where: { session_id }
    });

    // Delete the session record
    const deletedSessionCount = await Session.destroy({
      where: { session_id }
    });

    if (deletedSessionCount === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
      message: 'Session and associated data deleted successfully',
      deleted_stats_count: deletedStatsCount,
      deleted_session_count: deletedSessionCount
    });
  } catch (err) {
    console.error('DELETE /api/session/:session_id error:', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

export default router;
