/**
 * The inbox run over HTTP for tests: the drop dialog's calls, waiting until the run rests, and the
 * demo with the model stub where one payment is booked with its receipt.
 */
import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DropSession } from '../../src/types/drop.js';
import type { JournalEntry, Receipt } from '../../src/types/index.js';
import type { RunDetail } from '../../src/workflows/model.js';
import { DEMO_ROOT } from './workspace.js';
import { startApi } from './api-server.js';

export const RECEIPT = join(DEMO_ROOT, 'transactional-data/2026/receipts/20260105-example-cloud-invoice-2026-01.pdf');

export const SESSION = (api: { port: number }) => {
  const base = `http://127.0.0.1:${api.port}`;
  const post = async (path: string, body?: Buffer | object): Promise<DropSession> => {
    const r = await fetch(base + path, {
      method: 'POST', body: Buffer.isBuffer(body) ? new Uint8Array(body) : body ? JSON.stringify(body) : undefined,
      headers: Buffer.isBuffer(body) ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' },
    });
    const json = await r.json();
    if (!r.ok) throw new Error(`${r.status} ${json.error}`);
    return json as DropSession;
  };
  const runOf = async (id: string) => (await (await fetch(`${base}/api/automation/runs/${id}`)).json()) as RunDetail;
  /** Until no run of the inbox works any more. */
  const rest = async () => {
    for (let i = 0; i < 200; i++) {
      const v = (await (await fetch(`${base}/api/automation`)).json()) as { runs: Array<{ status: string }> };
      if (!v.runs.some((r) => r.status === 'running' || r.status === 'queued')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the inbox run did not come to rest');
  };
  const books = async () => (await (await fetch(`${base}/books.json`)).json()) as { receipts: Array<{ id: string }>; transactions: Array<{ ref: string }> };
  return { post, runOf, rest, books };
};

const STUB = join(process.cwd(), 'tests/support/stub-bin');
/** A camt.053 of the demo's Raiffeisen account with the one payment of CHF 1120.00 that the stub links the receipt to. */
const SCAFFOLD = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>G-1</MsgId><CreDtTm>2026-08-01T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>G-1</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Ntry><Amt Ccy="CHF">1120.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-08-01</Dt></BookgDt><AcctSvcrRef>REF-G</AcctSvcrRef><AddtlNtryInf>Geruestbau</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
const LINKS_TO_G = { suggestedFilename: '20260801-geruestbau.pdf', date: '2026-08-01', description: 'Gerüstbau, Gerüstmiete', amount: 1120, currency: 'CHF', confidence: 0.95, matchedTransactionRefs: ['REF-G'] };

/** The demo with the model stub, the statement read and booked, then the receipt dropped, linked and the payment booked again with it. */
export async function bookedWithReceipt(env: Record<string, string> = {}) {
  const api = await startApi('demo', { PATH: `${STUB}:${process.env.PATH}`, CLAUDE_STUB_ANSWER: JSON.stringify(LINKS_TO_G), ...env });
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  const session = SESSION(api);
  const full = async () => (await (await fetch(`http://127.0.0.1:${api.port}/books.json`)).json()) as { receipts: Receipt[]; mappings: Array<{ receiptId: string; transactionRef: string }>; journalEntries: JournalEntry[] };
  const onG = async () => (await full()).journalEntries.filter((e) => e.transactionRef === 'REF-G').map((e) => e.receipts);
  let s = await session.post('/api/drop');
  s = await session.post(`/api/drop/${s.id}/files?name=august.xml`, Buffer.from(SCAFFOLD));
  await session.rest();
  assert.deepEqual(await onG(), [[]], 'the statement run booked the payment without a receipt');
  const pdf = Buffer.concat([readFileSync(RECEIPT), Buffer.from('\n% Geruest_August\n')]);
  s = await session.post(`/api/drop/${s.id}/files?name=Geruest_August.pdf`, pdf);
  await session.rest();
  const rc = s.rows.at(-1)!;
  assert.deepEqual(await onG(), [[rc.id]], 'linked, and booked again with the receipt');
  return { api, session, s, rc, pdf, full, onG };
}
