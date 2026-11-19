/**
 * Privacy per document (docs/specs/payroll.md §22 decision 108, third review of walk 3): a receipt suggested or filed as a
 * fund's document, or whose own text carries a social security number, a person's label or a person of payroll.json beside
 * her birth date or insured wage, reaches no model on any path (src/booking/kept-from-models.ts), whatever it was taken for:
 * linked by her, unlinked, in a closed period, kinded by her as an invoice. Ordinary receipts (a telecom's «Guthaben» on a
 * bill to the owner, a temp agency's «Lohn», a French «Avoir») reach the prompts unchanged. Recorded where the model is:
 * the real ask path (src/llm/ask.ts) spawns a stub `claude` that writes every prompt down. Invented people only.
 */
import './support/demo-workspace.js';
import './support/jurisdiction.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks, PERSON, saveBooks, update } from '../src/books/store.js';
import { cleanUp, drop, firm, pay, run } from './support/payslip-firm.js';
import { textPdf } from './support/text-pdf.js';
import { savePayroll } from '../src/payroll/store.js';
import { firm as payrollFirm, owner } from './support/payroll.js';
import { setPayrollPeople, textKeptFromModels } from '../src/booking/kept-from-models.js';
import { assistantArgs } from '../src/assistant/claude.js';

const dir = mkdtempSync(join(tmpdir(), 'privacy-w3-'));
after(() => { cleanUp(); rmSync(dir, { recursive: true, force: true }); });

const SSN = ['756', '1234', '5678', '97'].join('.');
const cert = (head: string, more: string[] = []) => ['Vorsorgestiftung Beispiel', head, 'Vertragsnummer: V-77', 'Versicherte Person: Mila Beispiel', `AHV-Nr. ${SSN}`, 'Geburtsdatum 12.05.1980', "Versicherter Lohn CHF 92'000.00", 'Beitrag Arbeitnehmer pro Monat 300.00', ...more];
const SWISSCOM = ['Swisscom (Schweiz) AG', 'Rechnung 12.08.2026', 'Mila Beispiel, Teegasse 1, 6300 Zug', 'Abo Inone 59.00', 'Guthaben aus Vormonat -12.50', 'MWST 8.1 % 3.76', 'Total CHF 50.26'];
const TEMP = ['Temporär Beispiel AG', 'Rechnung Nr. 4411 vom 31.07.2026', 'Einsatz Hans Muster', "Lohn 40.00 Std à 45.00 1'800.00", 'Spesen 120.00', 'MWST 8.1 % 155.52', "Total CHF 2'075.52"];
const AVOIR = ['Fournisseur Exemple SA', 'Avoir n° 2026-14 du 03.09.2026', 'Client: Teegarten Mila Beispiel GmbH', 'Avoir 250.00', 'TVA 8.1 % 18.73', 'Total avoir CHF 250.00'];

test('decision 108, per document: what keeps a text from models, and what does not', () => {
  setPayrollPeople(() => ['Mila Beispiel']);
  try {
    assert.ok(textKeptFromModels(cert('Vorsorgeausweis per 1.7.2026').join('\n')));
    assert.ok(textKeptFromModels(`Beleg\nAHV-Nr. ${SSN}`), 'a social security number');
    assert.ok(textKeptFromModels('Fondation Exemple\nPersonne assurée: Corinne Wyss'), 'a person\'s label');
    assert.ok(textKeptFromModels('Pensionskasse\nBeispiel Mila\nGeburtsdatum 12.05.1980'), 'her name beside her birth date');
    for (const ordinary of [SWISSCOM, TEMP, AVOIR]) assert.equal(textKeptFromModels(ordinary.join('\n')), false, ordinary[0]);
    // Last review: the detail beside her name (same or next line), a birth word with its date, the number with its check digit.
    assert.equal(textKeptFromModels('Mila Beispiel\nTeegasse 1\n6300 Zug\nRechnung\nGeburtsdatum 12.05.1980'), false, 'her birth date far from her name');
    assert.equal(textKeptFromModels('Mila Beispiel, geb. Muster\nGeburtsdatum fehlt'), false, 'a birth word without a date');
    assert.equal(textKeptFromModels(`Beleg\nRef ${SSN.slice(0, -1)}8`), false, 'a number whose check digit is wrong');
  } finally { setPayrollPeople(() => []); }
});

test('decision 108 through the real ask path: four certificates reach no prompt; ordinary receipts do, unchanged', async () => {
  const prompts = join(dir, 'prompts.txt');
  const keys = ['CLAUDE_BIN', 'CLAUDE_STUB_PROMPTS', 'VANILLA_AI_SETTINGS', 'VANILLA_WORKSPACE'] as const;
  const env = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const ws = firm('Teegarten Wyss GmbH', [pay('P1', '2026-07-23', 600, 'Vorsorgestiftung Beispiel', 'Beitrag Juli'), pay('P2', '2026-08-23', 600, 'Vorsorgestiftung Beispiel', 'Beitrag August')]);
  Object.assign(process.env, { CLAUDE_BIN: join(process.cwd(), 'tests/support/stub-bin/claude'), CLAUDE_STUB_PROMPTS: prompts, VANILLA_AI_SETTINGS: join(dir, 'ai.json'), VANILLA_WORKSPACE: ws.paths.root });
  try {
    const { ask } = await import('../src/llm/ask.js');
    savePayroll(ws, payrollFirm([owner()]));
    await drop(ws, [
      ['linked.pdf', textPdf(cert('Vorsorgeausweis per 1.7.2026'))],
      ['billlike.pdf', textPdf(cert('Beitragsrechnung 1.7.2026', ['Zu bezahlender Betrag CHF 600.00 bis 31.08.2026']))],
      ['closed.pdf', textPdf(cert('Bescheinigung per 1.5.2026'))],
      ['human.pdf', textPdf(cert('Bescheinigung per 1.7.2026', ['Kopie']))],
      ['swisscom.pdf', textPdf(SWISSCOM)], ['temp.pdf', textPdf(TEMP)], ['avoir.pdf', textPdf(AVOIR)],
    ]);
    await run(ws, ask);
    // As if read before: kinds taken off, one linked by her, one kinded by her as an invoice.
    const books = loadBooks(ws);
    update(books, PERSON, (b) => {
      const by = (n: string) => b.receipts.find((r) => r.originalFilename === n || r.filename.includes(n.replace('.pdf', '')))!;
      for (const n of ['linked.pdf', 'billlike.pdf', 'closed.pdf', 'human.pdf']) { const r = by(n); delete r.kind; delete r.kindBy; delete r.kindRule; }
      b.mappings.push({ transactionRef: 'P1', receiptId: by('linked.pdf').id, rule: 'manual' } as never);
      Object.assign(by('human.pdf'), { kind: 'invoice', kindBy: 'human' });
    });
    saveBooks(ws, books);
    await run(ws, ask);
    assert.ok(existsSync(prompts), 'the model was asked');
    const sent = readFileSync(prompts, 'utf8');
    assert.deepEqual([SSN, '12.05.1980', "92'000", 'Versicherte Person'].filter((w) => sent.includes(w)), [], 'nothing of a certificate reached a prompt');
    for (const w of ['Guthaben aus Vormonat', "Lohn 40.00 Std à 45.00 1'800.00", 'Avoir n° 2026-14', 'Mila Beispiel, Teegasse 1']) assert.ok(sent.includes(w), `an ordinary receipt reaches the prompt unchanged: ${w}`);
  } finally {
    for (const k of keys) if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

test('decision 108: the sidebar is denied the files of a fund\'s documents', () => {
  const args = assistantArgs({ language: 'de' }, undefined, '/repo', '2850', '', undefined, ['**/transactional-data/*/receipts/20260701-vorsorgeausweis.pdf']);
  assert.ok(args.includes('Read(**/transactional-data/*/receipts/20260701-vorsorgeausweis.pdf)'));
});

test('last review: the titles step never names a receipt kept from models', async () => {
  const { titlesStep } = await import('../src/intake/titles.js');
  const { storePort } = await import('../src/intake/pipeline.js');
  const { moduleActor } = await import('../src/books/store.js');
  const ws = firm('Teegarten Wyss GmbH', []);
  const books = loadBooks(ws);
  update(books, PERSON, (b) => {
    b.receipts.push({ id: 'c1', filename: 'c1.pdf', location: 'archived', indexedAt: '', fileSize: 1, extractionMethod: 'pdftotext', extractedText: cert('Vorsorgeausweis per 1.7.2026').join('\n') } as never);
    b.receipts.push({ id: 'o1', filename: 'o1.pdf', location: 'archived', indexedAt: '', fileSize: 1, extractionMethod: 'pdftotext', extractedText: SWISSCOM.join('\n') } as never);
  });
  saveBooks(ws, books);
  const prompts: string[] = [];
  await titlesStep()({ ws, books: storePort(ws, moduleActor('titles')), ask: async (p: string) => { prompts.push(p); return '{}'; }, progress: () => {}, log: () => {} } as never);
  assert.ok(prompts.some((p) => p.includes('Swisscom')), 'an ordinary receipt is named');
  assert.ok(prompts.every((p) => !p.includes(SSN) && !p.includes('Versicherte Person')), 'the certificate is not');
});
