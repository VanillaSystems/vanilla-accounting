/**
 * The company's decisions for the booking steps (knowledge/rules/booking.guide.yaml) and those of
 * the payment's business file reach the classify prompt beside the receipt that names the item:
 * a precedent that calls a kind of item private books it so although the bank text names only
 * the shop (src/knowledge/guidance.ts). The model is a stub that answers as told.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTransactions, loadClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { guidanceOf } from '../src/knowledge/guidance.js';
import { buildBatchClassifyPrompt, GUIDANCE_LIMIT } from '../src/llm/prompts.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import { workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

const VAN = 'the old delivery van was sold: anything for the old van is private (D 2451, no VAT code)';

/** The demo company with a precedent of the `private` step and a parts shop whose file holds one decision of its own. */
function company(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'guidance-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  mkdirSync(join(dir, 'knowledge/rules'), { recursive: true });
  writeFileSync(join(dir, 'knowledge/rules/booking.guide.yaml'), [
    'process: booking',
    'steps:',
    '  private:',
    '    precedents:',
    `      - { id: prec-old-van, date: 2026-10-01, item: "van parts and tools", decision: "${VAN}", by: owner }`,
    '  classify:',
    '    rules:',
    '      - id: rule-in-code',
    '        then: { account: "6200" }',
    '        source: wish 2026-10-01',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'knowledge/suppliers/teileshop-muster.yaml'), [
    'id: teileshop-muster',
    'name: Teileshop Muster',
    'match:',
    '  tx: ["teileshop muster"]',
    'steps:',
    '  booking.guide.yaml#private:',
    '    precedents:',
    '      - { id: prec-teileshop-gift, item: "gift cards", decision: "private", by: owner }',
    '',
  ].join('\n'));
  return workspaceAt(dir);
}

const PAYMENT: BankTransaction = { ref: 'CARD-1', bank: 'Raiffeisen', date: '2026-08-14', amount: 18.5, currency: 'CHF', direction: 'DBIT', description: 'Kartenzahlung Teileshop Muster' };
const RECEIPT = {
  id: 'r1', filename: '20260814-teileshop-muster.pdf', extractedText: 'Teileshop Muster AG, Rechnung 4711. MWST CHE-111.222.333 8.1%. Total CHF 18.50',
  date: '2026-08-14', amount: 18.5, currency: 'CHF', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, gross: 18.5, vat: 1.39 }],
  lineItems: [{ description: 'Side mirror indicator for the old delivery van', gross: 18.5, ratePercent: 8.1 }],
} as unknown as Receipt;
const books = (): Books => ({
  transactions: [PAYMENT], receipts: [RECEIPT], mappings: [{ transactionRef: PAYMENT.ref, receiptId: RECEIPT.id }],
  bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' },
} as unknown as Books);

test('the company\'s precedent, the business file\'s decision and the receipt\'s item reach the classify prompt, and the private answer books without a VAT code', async () => {
  const prompts: string[] = [];
  const ask: ClassifyDeps['ask'] = async (prompt) => {
    prompts.push(prompt);
    return JSON.stringify({ [PAYMENT.ref]: { entries: [{ accountDebit: '2451', accountCredit: '', amount: 18.5, vat: 'none', description: 'Teileshop Muster, Spiegelblinker (privat)' }], reason: 'prec-old-van' } });
  };
  const b = books();
  const out = await classifyTransactions(b, [PAYMENT], { ask, fx: loadFxResolver(), context: loadClassifyContext(company()) });
  const [prompt] = prompts;
  assert.ok(prompt.includes(`[private prec-old-van] van parts and tools: ${VAN}`), 'the company precedent is in the prompt');
  assert.ok(prompt.includes('owner\'s account 2451'), 'the prompt names the owner\'s account a private purchase goes to');
  assert.ok(prompt.includes('Decisions of Teileshop Muster\'s file') && prompt.includes('[private prec-teileshop-gift] gift cards: private'), 'the business file\'s decision rides with its payment');
  assert.ok(prompt.includes('Items: Side mirror indicator for the old delivery van'), 'the receipt\'s item is in the prompt');
  assert.ok(!prompt.includes('rule-in-code'), 'a rule code carries out is not shown to the model');
  assert.deepEqual(out.classified, [PAYMENT.ref], JSON.stringify(out.failed));
  assert.deepEqual(b.journalEntries.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']), [['2451', '1021', 18.5, '']]);
});

test('a company without decisions gets no decisions section', () => {
  const prompt = buildBatchClassifyPrompt([{ tx: { ...PAYMENT }, receipts: [] }], { companyName: 'X', chartOfAccounts: '', historicEntries: '' });
  assert.ok(!prompt.includes('## The company\'s decisions'));
});

test('past the limit the newest decisions are shown and the prompt says how many older ones are left out', () => {
  const guidance = Array.from({ length: GUIDANCE_LIMIT + 3 }, (_, i) => ({ step: 'private', id: `p${i}`, text: `item ${i}: private` }));
  const prompt = buildBatchClassifyPrompt([{ tx: { ...PAYMENT }, receipts: [] }], { companyName: 'X', chartOfAccounts: '', historicEntries: '', guidance });
  assert.ok(!prompt.includes('[private p2]') && prompt.includes(`[private p${GUIDANCE_LIMIT + 2}]`));
  assert.ok(prompt.includes(`(3 older decisions left out: at most ${GUIDANCE_LIMIT} in one prompt.)`));
});

test('a section gives its rules in words and its precedents; a rule switched off or carried out by code is not among them', () => {
  const got = guidanceOf('private', {
    rules: [{ id: 'a', when: 'a gift', then: 'private' }, { id: 'b', then: { account: '6200' } as never }, { id: 'c', then: 'off', off: true } as never],
    precedents: ['plain words', { id: 'd', item: 'tools', decision: 'business' }, { id: 'e' }],
  });
  assert.deepEqual(got, [
    { step: 'private', id: 'a', text: 'when a gift: private' },
    { step: 'private', text: 'plain words' },
    { step: 'private', id: 'd', text: 'tools: business' },
  ]);
});
