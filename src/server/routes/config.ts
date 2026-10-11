import { Router } from 'express';
import { accountsOf, filedReturnsOf } from '../../workspace/reads.js';
import { WS, RequestError, patchBody, readBooks, reopenWorkspace, stringField } from '../books.js';
import { readEstvRateTable } from '../../accounting/fx-rates.js';
import { companyInfo } from '../../books/company.js';
import { WorkspaceError } from '../../workspace/workspace.js';
import { patchManifest, type BankPatch, type ManifestPatch, type NewBank, type ProfilePatch } from '../../workspace/manifest-write.js';
import { setAccountName } from '../../workspace/accounts-write.js';
import type { Address } from '../../invoices/model.js';

export const router = Router();

/** A refusal of the manifest's or the chart's own checks is the user's to fix: 400 with its text. */
function checked<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof WorkspaceError) throw new RequestError(400, e.message);
    throw e;
  }
}

router.get('/api/accounts', (_req, res) => {
  res.json(accountsOf(WS));
});

router.put('/api/accounts/:number', (req, res) => {
  const name = stringField(patchBody(req.body, ['name']), 'name');
  res.json(checked(() => setAccountName(WS, req.params.number, name)));
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
  res.json(companyInfo(WS, readBooks()));
});

const optText = (b: Record<string, unknown>, key: string): string | null | undefined =>
  b[key] === undefined || b[key] === null ? (b[key] as null | undefined) : stringField(b, key);

function profilePatch(raw: unknown): ProfilePatch {
  const b = patchBody(raw, ['name', 'uid', 'owner', 'business', 'address']);
  const out: ProfilePatch = {};
  for (const key of ['name', 'uid', 'owner'] as const) if (b[key] !== undefined) out[key] = stringField(b, key);
  if (b.business !== undefined) out.business = optText(b, 'business');
  if (b.address === null) out.address = null;
  else if (b.address !== undefined) {
    const a = patchBody(b.address, ['street', 'number', 'line2', 'postcode', 'town', 'state', 'country']);
    out.address = Object.fromEntries(Object.keys(a).map((k) => [k, optText(a, k) ?? undefined])) as unknown as Address;
  }
  return out;
}

function bankPatch(raw: unknown): BankPatch {
  const b = patchBody(raw, ['bank', 'currency', 'label', 'iban']);
  return { bank: stringField(b, 'bank'), currency: stringField(b, 'currency'), label: optText(b, 'label') ?? undefined, iban: optText(b, 'iban') };
}

function newBank(raw: unknown): NewBank {
  const b = patchBody(raw, ['bank', 'currency', 'account', 'label', 'iban']);
  return { bank: stringField(b, 'bank'), currency: stringField(b, 'currency'), account: stringField(b, 'account'), label: stringField(b, 'label'), iban: optText(b, 'iban') ?? undefined };
}

/**
 * The company's profile and bank accounts in belege.workspace.yaml, patched field by field
 * (src/workspace/manifest-write.ts). No record of the books changes, so no period is closed to it.
 */
router.patch('/api/workspace', (req, res) => {
  const b = patchBody(req.body, ['company', 'banks', 'addBank']);
  if (b.banks !== undefined && !Array.isArray(b.banks)) throw new RequestError(400, 'banks: eine Liste erwartet.');
  const patch: ManifestPatch = {
    ...(b.company === undefined ? {} : { company: profilePatch(b.company) }),
    ...(b.banks === undefined ? {} : { banks: (b.banks as unknown[]).map(bankPatch) }),
    ...(b.addBank === undefined ? {} : { addBank: newBank(b.addBank) }),
  };
  checked(() => patchManifest(WS.paths.manifest, patch));
  reopenWorkspace();
  res.json(companyInfo(WS, readBooks()));
});

router.get('/api/config', (_req, res) => {
  res.json(readBooks().config);
});
