import { Router } from 'express';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/errors.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../middleware/audit.js';

const router = Router();
router.use(requireAuth);

const PAGE = 'notifications';

// GET /api/notifications — the user's notifications plus broadcasts
router.get(
  '/',
  requirePermission(PAGE, 'view'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, type, severity, title, message, entity_type, entity_id, is_read, created_at
         FROM notifications
        WHERE user_id = $1 OR user_id IS NULL
        ORDER BY created_at DESC
        LIMIT 200`,
      [req.user.id]
    );
    const unread = rows.filter((r) => !r.is_read).length;
    res.json({ notifications: rows, unread });
  })
);

// GET /api/notifications/unread-count — for the top bar bell
router.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM notifications
        WHERE (user_id = $1 OR user_id IS NULL) AND is_read = false`,
      [req.user.id]
    );
    res.json({ unread: rows[0].n });
  })
);

// POST /api/notifications/:id/read
router.post(
  '/:id/read',
  requirePermission(PAGE, 'view'),
  asyncHandler(async (req, res) => {
    await query(
      `UPDATE notifications SET is_read = true
        WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)`,
      [Number(req.params.id), req.user.id]
    );
    res.json({ ok: true });
  })
);

// POST /api/notifications/read-all
router.post(
  '/read-all',
  requirePermission(PAGE, 'view'),
  asyncHandler(async (req, res) => {
    await query(
      `UPDATE notifications SET is_read = true WHERE user_id = $1 OR user_id IS NULL`,
      [req.user.id]
    );
    res.json({ ok: true });
  })
);

export default router;
