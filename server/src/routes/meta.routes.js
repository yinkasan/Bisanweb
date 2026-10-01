import { Router } from 'express';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Values the expenses form offers — mirrors PAYMENT_METHODS in financialService.
const PAYMENT_METHODS = ['Cash', 'POS', 'Bank Transfer', 'Cheque', 'Bank Deposit'];

// GET /api/meta/expense-categories — categories for the expense entry form
router.get(
  '/expense-categories',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, name, is_active FROM expense_categories WHERE is_active ORDER BY name`
    );
    res.json({ categories: rows });
  })
);

// GET /api/meta/payment-methods — allowed payment method values
router.get('/payment-methods', (req, res) => {
  res.json({ methods: PAYMENT_METHODS });
});

export default router;
