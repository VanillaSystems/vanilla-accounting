import { Router } from 'express';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFiledReturn } from '../../accounting/filed-return.js';
import { WS, readBooks } from '../books.js';

export const router = Router();

router.get('/api/accounts', (_req, res) => {
  const accountsPath = WS.paths.accounts;
  if (!existsSync(accountsPath)) { res.json([]); return; }
  res.json(JSON.parse(readFileSync(accountsPath, 'utf8')));
});

// The VAT returns as filed with the ESTV (filings/<year>/), read-only.
router.get('/api/vat/filed', (req, res) => {
  const year = String(req.query.year ?? '');
  if (!/^\d{4}$/.test(year)) { res.status(400).json({ error: 'year=YYYY required' }); return; }
  const dir = join(WS.paths.filings, year);
  if (!existsSync(dir)) { res.json([]); return; }
  try {
    const files = readdirSync(dir).filter((f) => /^mwst-ech0217-\d{4}-Q[1-4]\.xml$/.test(f)).sort();
    res.json(files.map((f) => parseFiledReturn(readFileSync(join(dir, f), 'utf8'))));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Who the company is and which ledger account each bank books on (belege.workspace.yaml).
router.get('/api/workspace', (_req, res) => {
  res.json({ company: WS.company, bankAccounts: WS.bankAccounts });
});

router.get('/api/config', (_req, res) => {
  res.json(readBooks().config);
});
