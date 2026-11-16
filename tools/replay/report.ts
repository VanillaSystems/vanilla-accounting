/**
 * A replay's result (result.json) and its short summary (summary.md): the payments counted, the
 * period's figures against the key's, and the tokens per phase, step and model. Both hold the
 * company's refs and figures: they stay in the run folder.
 */
import type { LedgerRow } from '../../src/llm/ask.js';
import type { Marker } from './cut.js';
import type { AnswerKey } from './key.js';
import type { CaseResult, Outside } from './drive.js';
import type { Pass, TouchKind } from './oracle.js';

export interface Phase { name: string; startedAt: string; ledgerFrom: number; ledgerTo: number; ms: number }

export interface Tokens { calls: number; failed: number; input: number; cacheCreate: number; cacheRead: number; output: number }

const zero = (): Tokens => ({ calls: 0, failed: 0, input: 0, cacheCreate: 0, cacheRead: 0, output: 0 });
function add(t: Tokens, r: LedgerRow): Tokens {
  t.calls++;
  if (!r.ok) t.failed++;
  t.input += r.input; t.cacheCreate += r.cacheCreate; t.cacheRead += r.cacheRead; t.output += r.output;
  return t;
}

/**
 * The ledger's rows per phase, step and model. A row's model is the one the call named (the CLI's
 * alias); when the CLI reported the models it used (`models`), their ids are listed beside it.
 */
export function tokensOf(rows: readonly LedgerRow[], phases: readonly Phase[]) {
  const phaseOf = (i: number) => phases.find((p) => i >= p.ledgerFrom && i < p.ledgerTo)?.name ?? (i < (phases[0]?.ledgerFrom ?? 0) ? 'before' : 'after');
  const rowsOut: Array<{ phase: string; step: string; model: string } & Tokens> = [];
  const byModel: Record<string, Tokens> = {};
  const total = zero();
  const ids: Record<string, Tokens> = {};
  rows.forEach((r, i) => {
    const phase = phaseOf(i);
    const model = `${r.provider ?? 'claude-cli'} ${r.model}`;
    let row = rowsOut.find((x) => x.phase === phase && x.step === r.step && x.model === model);
    if (!row) { row = { phase, step: r.step, model, ...zero() }; rowsOut.push(row); }
    add(row, r);
    add(byModel[model] ??= zero(), r);
    add(total, r);
    for (const [id, u] of Object.entries((r as LedgerRow & { models?: Record<string, Omit<Tokens, 'calls' | 'failed'>> }).models ?? {})) {
      const t = ids[id] ??= zero();
      t.calls++; t.input += u.input; t.cacheCreate += u.cacheCreate; t.cacheRead += u.cacheRead; t.output += u.output;
    }
  });
  return { rows: rowsOut, byModel, total, ...(Object.keys(ids).length ? { modelIds: ids } : {}) };
}

export interface ScoreInput {
  key: AnswerKey;
  marker: Marker;
  model: 'stub' | 'real';
  results: CaseResult[];
  phases: Phase[];
  ledger: LedgerRow[];
  figures: { ziffern: Record<string, number>; payable: number };
  intake: Array<{ file: string; did: string; error?: string }>;
  outside: Outside[];
  otherFinal: Array<{ ref: string; kind: string; ok: boolean }>;
  manualFinal: Array<{ ref: string; ok: boolean }>;
  dropRows: Record<string, number>;
  wallMs: number;
  touchKinds: readonly TouchKind[];
}

export function score(i: ScoreInput) {
  const r = i.results;
  const untouched = r.filter((c) => !c.touches.length);
  const byKind = Object.fromEntries(i.touchKinds.map((k) => [k, r.filter((c) => c.touches.includes(k)).length])) as Record<TouchKind, number>;
  const touchesByKind = Object.fromEntries(i.touchKinds.map((k) => [k, r.reduce((n, c) => n + c.touches.filter((t) => t === k).length, 0)])) as Record<TouchKind, number>;
  const passes = Object.fromEntries((['right', 'wrong', 'asked', 'open'] as Pass[]).map((p) => [p, r.filter((c) => c.pass === p).length])) as Record<Pass, number>;
  const ziffern = [...new Set([...Object.keys(i.key.figures.ziffern), ...Object.keys(i.figures.ziffern)])].sort().map((z) => {
    const replayed = i.figures.ziffern[z] ?? 0;
    const key = i.key.figures.ziffern[z] ?? 0;
    return { ziffer: z, replayed, key, diff: Math.round((replayed - key) * 100) / 100 };
  });
  return {
    period: i.key.period, arm: i.marker.arm, model: i.model, madeAt: i.marker.madeAt, finishedAt: new Date().toISOString(), wallMs: i.wallMs,
    cases: {
      total: r.length,
      untouchedCorrect: untouched.filter((c) => c.final.ok).length,
      touched: r.length - untouched.length,
      /** Payments with at least one touch of the kind, and the touches of the kind in all. */
      touchedByKind: byKind,
      touchesByKind,
      /** Booked by the app, nothing asked, and not as the key has it: corrected by the oracle. */
      silentErrors: { count: passes.wrong, linesWrong: r.filter((c) => c.pass === 'wrong' && !c.first.lines).length, linksOnly: r.filter((c) => c.pass === 'wrong' && c.first.lines).length, refs: r.filter((c) => c.pass === 'wrong').map((c) => ({ ref: c.ref, diff: c.first.diff })) },
      afterAppRuns: passes,
      /** The oracle must close every payment: those it could not, with why. */
      notClosed: r.filter((c) => !c.final.ok).map((c) => ({ ref: c.ref, diff: c.final.diff, errors: c.errors })),
      untouchedRefs: untouched.map((c) => c.ref),
      list: r,
    },
    outside: {
      manual: { total: i.manualFinal.length, ok: i.manualFinal.filter((m) => m.ok).length },
      other: {
        total: i.otherFinal.length, ok: i.otherFinal.filter((o) => o.ok).length,
        report: i.otherFinal.filter((o) => o.kind === 'report').length,
        /** A provider report's refs the app booked as the key has them, with no hand of the oracle. */
        reportByApp: i.otherFinal.filter((o) => o.kind === 'report' && o.ok && !i.outside.some((a) => a.ref === o.ref)).length,
      },
      actions: i.outside,
      correctionsOfFiledNotReplayed: i.key.correctionsOfFiled,
    },
    intake: { rows: i.dropRows, touches: i.intake },
    figures: { keyFiled: i.key.figures.filed, payable: { replayed: i.figures.payable, key: i.key.figures.payable }, equal: ziffern.every((z) => z.diff === 0), ziffern },
    tokens: tokensOf(i.ledger, i.phases),
    phases: i.phases,
  };
}

export type Result = ReturnType<typeof score>;

const n = (x: number) => x.toLocaleString('en-US');
const mins = (ms: number) => `${(ms / 60000).toFixed(1)} min`;

export function summaryMarkdown(res: Result): string {
  const c = res.cases;
  const t = res.tokens;
  const lines = [
    `# Replay ${res.period}, ${res.arm} arm, model ${res.model}`,
    '',
    `Wall time ${mins(res.wallMs)}. ${c.total} payments.`,
    '',
    '| | payments |',
    '|---|---:|',
    `| untouched and correct | ${c.untouchedCorrect} |`,
    `| touched by the person | ${c.touched} |`,
    ...Object.entries(c.touchedByKind).map(([k, v]) => `| · ${k} | ${v} |`),
    `| silent errors (booked, nothing asked, wrong) | ${c.silentErrors.count} (lines ${c.silentErrors.linesWrong}, links only ${c.silentErrors.linksOnly}) |`,
    `| not closed by the oracle | ${c.notClosed.length} |`,
    '',
    `After the app's own runs: right ${c.afterAppRuns.right}, wrong ${c.afterAppRuns.wrong}, asked ${c.afterAppRuns.asked}, open ${c.afterAppRuns.open}.`,
    `Outside the payments: ${res.outside.manual.ok}/${res.outside.manual.total} hand movements right at the end, ${res.outside.other.ok}/${res.outside.other.total} other refs right at the end (${res.outside.other.report} of a provider report, ${res.outside.other.reportByApp} of them booked by the app untouched), ${res.outside.actions.length} oracle actions; ${res.intake.touches.length} answers at the drop; ${res.outside.correctionsOfFiledNotReplayed} corrections of filed periods not replayed.`,
    '',
    `## Figures (${res.figures.keyFiled ? 'key: filed' : 'key: booked, not filed'})`,
    '',
    `${res.figures.equal ? 'Every figure equals the key.' : 'Figures that differ:'} Payable: replayed ${res.figures.payable.replayed}, key ${res.figures.payable.key}.`,
    '',
    ...(res.figures.equal ? [] : ['| Ziffer | replayed | key | diff |', '|---|---:|---:|---:|', ...res.figures.ziffern.filter((z) => z.diff !== 0).map((z) => `| ${z.ziffer} | ${z.replayed} | ${z.key} | ${z.diff} |`), '']),
    '## Tokens',
    '',
    '| phase | step | model | calls | failed | input | cache create | cache read | output |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|',
    ...t.rows.map((r) => `| ${r.phase} | ${r.step} | ${r.model} | ${r.calls} | ${r.failed} | ${n(r.input)} | ${n(r.cacheCreate)} | ${n(r.cacheRead)} | ${n(r.output)} |`),
    `| **total** | | | ${t.total.calls} | ${t.total.failed} | ${n(t.total.input)} | ${n(t.total.cacheCreate)} | ${n(t.total.cacheRead)} | ${n(t.total.output)} |`,
    '',
    ...Object.entries(t.byModel).map(([m, x]) => `- ${m}: ${x.calls} calls, input ${n(x.input)}, cache create ${n(x.cacheCreate)}, cache read ${n(x.cacheRead)}, output ${n(x.output)}`),
    ...(t.modelIds ? ['', 'Models the CLI reported:', ...Object.entries(t.modelIds).map(([m, x]) => `- ${m}: input ${n(x.input)}, cache create ${n(x.cacheCreate)}, cache read ${n(x.cacheRead)}, output ${n(x.output)}`)] : []),
    '',
    `Phases: ${res.phases.map((p) => `${p.name} ${mins(p.ms)}`).join(', ')}.`,
    '',
  ];
  return lines.join('\n');
}
