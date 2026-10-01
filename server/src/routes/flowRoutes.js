import { Router } from 'express';
import { asyncHandler } from '../middleware/errors.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import {
  FLOW_CONFIGS, listFlow, getFlowById, createFlow, updateFlow, reverseFlow,
} from '../services/financialService.js';

/**
 * One router per "flow" page (cash sales, POS sales, credit sales, payments,
 * purchases, expenses). Write operations re-check permissions inside the
 * service so the rules live in one place.
 */
export function createFlowRouter(configKey) {
  const config = FLOW_CONFIGS[configKey];
  if (!config) throw new Error(`Unknown flow config: ${configKey}`);

  const router = Router();
  router.use(requireAuth);

  // GET / — filtered, paginated list with posted totals
  router.get(
    '/',
    requirePermission(config.pageKey, 'view'),
    asyncHandler(async (req, res) => {
      res.json(await listFlow(config, req.user, req.query));
    })
  );

  // GET /:id
  router.get(
    '/:id',
    requirePermission(config.pageKey, 'view'),
    asyncHandler(async (req, res) => {
      res.json({ item: await getFlowById(config, req.user, Number(req.params.id)) });
    })
  );

  // POST / — record a transaction (needs "input")
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const item = await createFlow(config, req.user, req.body ?? {}, req);
      res.status(201).json({ item });
    })
  );

  // PUT /:id — correction in place, reason required, history preserved
  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const item = await updateFlow(config, req.user, Number(req.params.id), req.body ?? {}, req);
      res.json({ item });
    })
  );

  // POST /:id/reverse — never deletes; the original stays in the audit trail
  router.post(
    '/:id/reverse',
    asyncHandler(async (req, res) => {
      const item = await reverseFlow(config, req.user, Number(req.params.id), req.body ?? {}, req);
      res.json({ item });
    })
  );

  return router;
}
