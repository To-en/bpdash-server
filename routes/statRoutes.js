import express from 'express';
import { Op } from 'sequelize';
import { Stat } from '../models/stat_schema.js';

const router = express.Router();

/**
 * GET /
 * Poll stat (DESC order)
 * Optional query: ?since=ISO_TIMESTAMP — only return records created after this time
 */
router.get('/', async (req, res) => {
  try {
    const where = {};
    if (req.query.since) {
      where.createdAt = { [Op.gte]: new Date(req.query.since) };
    }

    const stats = await Stat.findAll({
      where,
      order: [['createdAt', 'DESC']]
    });

    res.json(stats);
  } catch (err) {
    console.error('GET /api/stat error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * DELETE /delete
 * ลบข้อมูลตาม session_name
 * body: { "session_name": "my session" }
 */
router.delete('/delete', async (req, res) => {
  try {
    const { session_name } = req.body;

    if (session_name == null) {
      return res.status(400).json({
        error: 'session_name is required'
      });
    }

    const deletedCount = await Stat.destroy({
      where: { session_name }
    });

    if (deletedCount === 0) {
      return res.status(404).json({
        message: 'No records found to delete'
      });
    }

    res.json({
      message: 'Successfully deleted records',
      deleted_count: deletedCount,
      criteria: { session_name }
    });

  } catch (err) {
    console.error('DELETE /api/stat/delete error:', err);
    res.status(500).json({
      error: 'Internal Server Error',
      details: err.message
    });
  }
});

/**
 * DELETE /delete-unnamed
 * ลบข้อมูลที่ session_name เป็น null (ข้อมูลที่ไม่ได้อยู่ใน session)
 */
router.delete('/delete-unnamed', async (req, res) => {
  try {
    const deletedCount = await Stat.destroy({
      where: { session_name: null }
    });

    res.json({
      message: 'Successfully deleted unnamed records',
      deleted_count: deletedCount
    });

  } catch (err) {
    console.error('DELETE /api/stat/delete-unnamed error:', err);
    res.status(500).json({
      error: 'Internal Server Error',
      details: err.message
    });
  }
});

/**
 * DELETE /delete-all
 * ลบข้อมูลทั้งหมด (เกลี้ยงหมด)
 */
router.delete('/delete-all', async (req, res) => {
  try {
    const deletedCount = await Stat.destroy({
      where: {},
      truncate: false
    });

    res.json({
      message: 'Successfully deleted all records',
      deleted_count: deletedCount
    });

  } catch (err) {
    console.error('DELETE /api/stat/delete-all error:', err);
    res.status(500).json({
      error: 'Internal Server Error',
      details: err.message
    });
  }
});

export default router;
