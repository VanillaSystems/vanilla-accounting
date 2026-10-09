import { Router } from 'express';
import { accountsOf, filedReturnsOf, workspaceInfo } from '../../workspace/reads.js';
import { WS, readBooks } from '../books.js';
import { readEstvRateTable } from '../../accounting/fx-rates.js';

export const router = Router();

router.get('/api/accounts', (_req, res) => {
  res.json(accountsOf(WS));
});

// The VAT returns as filed with the ESTV (filings/<year>/), read-only.
router.get('/api/vat/filed', (req, res) => {
  const year = String(req.query.year ?? '');
  if (!/^\d{4}$/.test(year)) { res.status(400).json({ error: 'year=YYYY required' }); return; }
  try {
    res.json(filedReturnsOf(WS, year));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// The ESTV daily sell rates the books convert foreign amounts with (reference/, public data).
router.get('/api/fx-rates', (_req, res) => {
  res.json(readEstvRateTable());
});

router.get('/api/workspace', (_req, res) => {
  res.json(workspaceInfo(WS));
});

router.get('/api/config', (_req, res) => {
  res.json(readBooks().config);
});
