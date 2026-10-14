/**
 * Every statement under bank-statements/, with the ledger account it lands on. Extract (the
 * transactions), reconcile-balances (the closing balances), the import board and doctor all
 * read the folder through here, so they agree on which file counts.
 *
 * Any *.xml at any depth is read, whatever its name. A camt.053 statement whose id was already
 * read for the same account is a duplicate (the same download kept twice) and is skipped. A
 * folder holding statements of two IBANs in one currency is a problem: both would book on one
 * ledger account.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { accountForStatement, type StatementMatch } from '../accounting/bank-accounts.js';
import { readCamt, type CamtMessage, type CamtStatement } from '../providers/camt053/camt053.js';
import type { Workspace } from './workspace.js';

type Matched = Extract<StatementMatch, { account: unknown }>;

export type StatementFile =
  | { status: 'read'; file: string; statement: CamtStatement; account: Matched['account']; by: Matched['by'] }
  | { status: 'duplicate'; file: string; statement: CamtStatement; of: string }
  | { status: 'unmatched'; file: string; statement: CamtStatement; problem: string }
  | { status: 'skipped'; file: string; message: CamtMessage | 'unreadable'; reason: string };

const SKIPPED: Record<Exclude<CamtMessage, 'camt.053'>, string> = {
  'camt.052': 'a camt.052 is an intraday account report, not a statement: its bookings come again in the camt.053. Download the camt.053 (Kontoauszug) instead.',
  'camt.054': 'a camt.054 is a booking notification (Avis): its bookings are in the camt.053 too, so reading both would count them twice. Download the camt.053 (Kontoauszug) instead.',
  other: 'not a camt.053 bank statement.',
};

/** *.xml files under `dir`, relative to it, in directory order (dot files skipped). */
function xmlFiles(dir: string, root = dir): string[] {
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return []; }
  return names.filter((n) => !n.startsWith('.')).flatMap((n) => {
    const path = join(dir, n);
    if (statSync(path).isDirectory()) return xmlFiles(path, root);
    return n.toLowerCase().endsWith('.xml') ? [relative(root, path)] : [];
  });
}

export function readBankStatements(ws: Pick<Workspace, 'paths' | 'bankAccounts'>): StatementFile[] {
  const out: StatementFile[] = [];
  const seen = new Map<string, string>();
  const ibanOf = new Map<string, { iban: string; file: string }>();
  for (const file of xmlFiles(ws.paths.statements)) {
    const folder = file.includes(sep) ? file.split(sep)[0] : '';
    let camt: ReturnType<typeof readCamt>;
    try {
      camt = readCamt(readFileSync(join(ws.paths.statements, file), 'utf8'));
    } catch (e) {
      out.push({ status: 'skipped', file, message: 'unreadable', reason: `does not read as XML (${(e as Error).message.split('\n')[0]}).` });
      continue;
    }
    if (camt.message !== 'camt.053') {
      out.push({ status: 'skipped', file, message: camt.message, reason: SKIPPED[camt.message] });
      continue;
    }
    for (const statement of camt.statements) {
      const match = accountForStatement(ws.bankAccounts, { iban: statement.iban, currency: statement.currency, folder });
      if ('problem' in match) { out.push({ status: 'unmatched', file, statement, problem: match.problem }); continue; }
      const { account } = match;
      const first = statement.iban ? ibanOf.get(`${account.bank} ${account.currency}`) : undefined;
      if (first && first.iban !== statement.iban) {
        out.push({ status: 'unmatched', file, statement, problem: `bank-statements/${folder}/ holds statements of two ${account.currency} accounts: IBAN ${first.iban} (${first.file}) and IBAN ${statement.iban}. Add iban: ${first.iban} to ${account.bank} ${account.currency} in belege.workspace.yaml, and list the other account with its own bank label, ledger account and iban.` });
        continue;
      }
      if (statement.iban) ibanOf.set(`${account.bank} ${account.currency}`, { iban: statement.iban, file });
      const key = `${account.bank} ${account.currency} ${statement.id}`;
      const earlier = seen.get(key);
      if (earlier) { out.push({ status: 'duplicate', file, statement, of: earlier }); continue; }
      seen.set(key, file);
      out.push({ status: 'read', file, statement, account, by: match.by });
    }
  }
  return out;
}
