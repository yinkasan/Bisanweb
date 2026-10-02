/**
 * /notifications — port of server/src/routes/notifications.routes.js.
 */
import { json } from '../../_shared/http.ts';
import { query, queryOne } from '../../_shared/db.ts';
import { assertPermission } from '../../_shared/auth.ts';
import { under, type Ctx, type ModuleHandler } from '../_ctx.ts';

const PAGE = 'notifications';

export const handleNotifications: ModuleHandler = async (c: Ctx): Promise<Response | null> => {
  const rest = under(c.path, '/notifications');
  if (!rest) return null;
  const { method, user } = c;

  // GET /notifications — the user's notifications plus broadcasts
  if (method === 'GET' && rest === '/') {
    assertPermission(user, PAGE, 'view');
    const rows = await query(
      `SELECT id, type, severity, title, message, entity_type, entity_id, is_read, created_at
         FROM notifications
        WHERE user_id = $1 OR user_id IS NULL
        ORDER BY created_at DESC
        LIMIT 200`,
      [user.id],
    );
    const unread = rows.filter((r: Record<string, any>) => !r.is_read).length;
    return json({ notifications: rows, unread });
  }

  // GET /notifications/unread-count — for the top bar bell
  if (method === 'GET' && rest === '/unread-count') {
    const row = await queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM notifications
        WHERE (user_id = $1 OR user_id IS NULL) AND is_read = false`,
      [user.id],
    );
    return json({ unread: row?.n ?? 0 });
  }

  // POST /notifications/read-all (before the /:id/read pattern)
  if (method === 'POST' && rest === '/read-all') {
    assertPermission(user, PAGE, 'view');
    await query(
      `UPDATE notifications SET is_read = true WHERE user_id = $1 OR user_id IS NULL`,
      [user.id],
    );
    return json({ ok: true });
  }

  // POST /notifications/:id/read
  const readMatch = /^\/(\d+)\/read$/.exec(rest);
  if (method === 'POST' && readMatch) {
    assertPermission(user, PAGE, 'view');
    await query(
      `UPDATE notifications SET is_read = true
        WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)`,
      [Number(readMatch[1]), user.id],
    );
    return json({ ok: true });
  }

  return null;
};
