/**
 * npm run llm-usage
 *
 * Measured model usage per step, from data/llm-ledger.jsonl (written by
 * src/llm/ask.ts on every call): calls, failures, tokens sent before and with
 * the prompt, tokens out, and time.
 */

import { readFileSync, existsSync } from 'node:fs';
import { ledgerPath, type LedgerRow } from '../llm/ask.js';

if (!existsSync(ledgerPath())) {
  console.log('No calls recorded yet (data/llm-ledger.jsonl is written by every ask() call).');
  process.exit(0);
}

const rows: LedgerRow[] = readFileSync(ledgerPath(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const byStep = new Map<string, LedgerRow[]>();
for (const r of rows) byStep.set(`${r.step} (${r.model})`, [...(byStep.get(`${r.step} (${r.model})`) ?? []), r]);

const fmt = (n: number) => n.toLocaleString('de-CH');
console.log(`${'step (model)'.padEnd(52)} ${'calls'.padStart(6)} ${'failed'.padStart(6)} ${'in/call'.padStart(9)} ${'out/call'.padStart(9)} ${'in total'.padStart(11)} ${'s/call'.padStart(7)}`);
for (const [step, rs] of [...byStep].sort()) {
  const input = rs.reduce((a, r) => a + r.input + r.cacheCreate + r.cacheRead, 0);
  const output = rs.reduce((a, r) => a + r.output, 0);
  const ms = rs.reduce((a, r) => a + r.ms, 0);
  console.log(`${step.padEnd(52)} ${String(rs.length).padStart(6)} ${String(rs.filter((r) => !r.ok).length).padStart(6)} ${fmt(Math.round(input / rs.length)).padStart(9)} ${fmt(Math.round(output / rs.length)).padStart(9)} ${fmt(input).padStart(11)} ${(ms / rs.length / 1000).toFixed(1).padStart(7)}`);
}
