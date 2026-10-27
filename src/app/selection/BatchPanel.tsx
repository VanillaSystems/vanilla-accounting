/**
 * The batch actions of a selection (#216), each with its preview before anything is written:
 * Belege «Kein Beleg», «Zahlung suchen», «Neu lesen (KI)», «Löschen»; Zahlungen «Braucht keinen
 * Beleg», «Buchen …» (account and VAT rate), «Regel daraus»; Buchungen «Konto ändern …», «MWST-Code …»,
 * «Dimension …». A filed object is left out and named; the toast takes the whole batch back.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Index } from '../../types/index.js';
import type { BatchAction, BatchAnswer } from '../../types/batch.js';
import { firmCodes } from '../../accounting/vat-codes.js';
import { api, errorText } from '../lib/api.js';
import { t } from '../i18n/index.js';
import { useWorkspace } from '../hooks/use-workspace.js';
import type { Nav } from '../areas/index.js';
import { AccountField } from '../areas/journal/AccountField.js';
import { ledgerFor } from '../areas/receipts/view.js';
import { journalFor } from '../areas/journal/commands.js';
import type { SelectKind } from './model.js';
import type { SelRow } from './SelectionView.js';
import { changeLines, doneIds, leftLines, preview, runBatch, runEach, type Line } from './batch.js';

/** What a batch can be: one the server runs, or one made of single requests. */
export type BatchId = 'notReceipt' | 'findPayment' | 'readAgain' | 'delete' | 'noReceiptNeeded' | 'book' | 'rule' | 'account' | 'vatCode' | 'tag';

/** «Neu lesen» asks the model once per receipt: at most this many at once. */
export const READ_AGAIN_MAX = 20;

export interface BatchOffer { id: BatchId; label: string }

export function batchOffers(kind: SelectKind, hasDimensions: boolean): BatchOffer[] {
  switch (kind) {
    case 'receipt': return [
      { id: 'findPayment', label: t('batch.findPayment') },
      { id: 'notReceipt', label: t('batch.notReceipt') },
      { id: 'readAgain', label: t('batch.readAgain') },
      { id: 'delete', label: t('batch.delete') },
    ];
    case 'payment': return [
      { id: 'book', label: t('batch.book') },
      { id: 'noReceiptNeeded', label: t('batch.noReceiptNeeded') },
      { id: 'rule', label: t('batch.rule') },
    ];
    case 'entry': return [
      { id: 'account', label: t('batch.account') },
      { id: 'vatCode', label: t('batch.vatCode') },
      ...(hasDimensions ? [{ id: 'tag' as const, label: t('batch.tag') }] : []),
    ];
  }
}

interface Props { kind: SelectKind; rows: SelRow[]; books: Index; nav: Nav; open: BatchId | null; onOpen(id: BatchId | null): void }

/** The form and preview of the batch picked in the Aktionen menu, below the selection's bar. */
export function BatchPanel(props: Props) {
  if (!props.open) return null;
  return <Panel key={`${props.open}:${props.rows.map((r) => r.id).join()}`} {...props} open={props.open} />;
}

function Panel({ kind, rows, books, nav, open, onOpen }: Props & { open: BatchId }) {
  const name = useMemo(() => { const m = new Map(rows.map((r) => [r.id, r.title])); return (id: string) => m.get(id) ?? id; }, [rows]);
  const ids = rows.map((r) => r.id);
  const close = () => onOpen(null);
  if (open === 'rule') return <RuleFromSelection rows={rows} nav={nav} onClose={close} />;
  if (open === 'findPayment' || open === 'readAgain' || open === 'delete') return <EachBatch which={open} books={books} rows={rows} nav={nav} name={name} onClose={close} />;
  return <ServerBatch which={open} kind={kind} books={books} ids={ids} nav={nav} name={name} onClose={close} />;
}

/** The lines of a preview: what changes, then what is left out and why, each object named. */
const COUNT = { receipt: 'batch.count.receipt', payment: 'batch.count.payment', entry: 'batch.count.entry' } as const;

function PreviewLines({ change, left, kind }: { change: Line[]; left: Line[]; kind: SelectKind }) {
  if (!change.length && !left.length) return <p className="m">{t('batch.nothing')}</p>;
  return (
    <ul className="preview" data-testid="batch-preview">
      {change.map((l) => <li key={l.text} data-tip={l.names.join(', ')}><b>{t(COUNT[kind], { n: l.n })}:</b> {l.text}</li>)}
      {left.map((l) => <li key={l.text} className="left" data-tip={l.names.join(', ')}>{t('batch.leftLine', { n: l.n, why: l.text, names: l.names.slice(0, 5).join(', ') + (l.names.length > 5 ? ' …' : '') })}</li>)}
    </ul>
  );
}

/** A batch the server runs: its fields, «Vorschau», then «Ausführen». A batch without fields shows its preview at once. */
function ServerBatch({ which, kind, books, ids, nav, name, onClose }: { which: Exclude<BatchId, 'rule' | 'findPayment' | 'readAgain' | 'delete'>; kind: SelectKind; books: Index; ids: string[]; nav: Nav; name(id: string): string; onClose(): void }) {
  const ws = useWorkspace();
  const [action, setAction] = useState<BatchAction | undefined>(which === 'notReceipt' || which === 'noReceiptNeeded' ? { kind: which } : undefined);
  const [answer, setAnswer] = useState<BatchAnswer>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!action) return;
    let live = true;
    setAnswer(undefined);
    setError('');
    preview(action, ids).then((a) => { if (live) setAnswer(a); }, (e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [JSON.stringify(action)]);
  const accounts = useMemo(() => {
    if (which !== 'account') return [];
    const j = journalFor(books);
    return [...new Set(ids.flatMap((id) => { const e = j.byId.get(id)?.e; return e ? [e.accountDebit, e.accountCredit] : []; }).filter(Boolean))].sort();
  }, [which, books, ids]);
  const dimensions = ws?.dimensions ?? [];

  function onPreview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '').trim();
    if (which === 'book') { if (!get('account')) { setError(t('batch.needAccount')); return; } setAction({ kind: 'book', account: get('account'), vat: get('vat') }); }
    if (which === 'account') { if (!get('to') || get('to') === get('from')) { setError(t('batch.needAccount')); return; } setAction({ kind: 'account', from: get('from'), to: get('to') }); }
    if (which === 'vatCode') setAction({ kind: 'vatCode', to: get('vat') });
    if (which === 'tag') setAction({ kind: 'tag', dimension: get('dimension'), value: get('value') || null });
  }

  async function run() {
    if (!action || busy) return;
    setBusy(true);
    const done = await runBatch(nav, action, ids);
    setBusy(false);
    if (done) onClose();
  }

  const fields = which === 'book' ? (
    <>
      <AccountField name="account" label={t('batch.field.account')} defaultValue="" />
      <label>{t('batch.field.vat')}<input name="vat" list="batch-vat" className="mono" placeholder={t('batch.field.vatHint')} /></label>
    </>
  ) : which === 'account' ? (
    <>
      <label>{t('batch.field.from')}<select name="from" className="mono">{accounts.map((a) => <option key={a} value={a}>{a}</option>)}</select></label>
      <AccountField name="to" label={t('batch.field.to')} defaultValue="" />
    </>
  ) : which === 'vatCode' ? (
    <label>{t('batch.field.vat')}<input name="vat" list="batch-vat" className="mono" placeholder={t('batch.field.vatNone')} /></label>
  ) : which === 'tag' ? (
    <>
      <label>{t('batch.field.dimension')}<select name="dimension">{dimensions.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></label>
      <label>{t('batch.field.value')}<input name="value" list="batch-tag" placeholder={t('tags.none')} /></label>
      <datalist id="batch-tag">{dimensions.flatMap((d) => d.values.filter((v) => v.active).map((v) => <option key={`${d.id}:${v.value}`} value={v.value}>{v.label ?? d.label}</option>))}</datalist>
    </>
  ) : null;

  return (
    <div className="batchform" data-batch={which}>
      {fields && (
        <form className="fields" onSubmit={onPreview} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
          {fields}
          <datalist id="batch-vat">{firmCodes().map((c) => <option key={c.code} value={c.code}>{c.bananaText ?? ''}</option>)}</datalist>
          <button type="submit" className="btn">{t('batch.preview')}</button>
        </form>
      )}
      {error && <p className="warnline">{error}</p>}
      {action && !answer && !error && <p className="m">{t('batch.previewing')}</p>}
      {answer && <PreviewLines change={changeLines(answer.changes, name)} left={leftLines(answer.left, name)} kind={kind} />}
      <div className="acts">
        <button type="button" className="btn primary" data-act="batch-run" disabled={!answer || !doneIds(answer).length || busy} onClick={() => void run()}>{t('batch.run', { n: answer ? doneIds(answer).length : 0 })}</button>
        <button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}

const LINE = { findPayment: 'batch.line.findPayment', readAgain: 'batch.line.readAgain', delete: 'batch.line.delete' } as const;

/** A batch of single requests: which receipts it takes, which it leaves out and why, then «Ausführen». */
function EachBatch({ which, books, rows, nav, name, onClose }: { which: 'findPayment' | 'readAgain' | 'delete'; books: Index; rows: SelRow[]; nav: Nav; name(id: string): string; onClose(): void }) {
  const l = ledgerFor(books);
  const [busy, setBusy] = useState(false);
  const why = (id: string): string | undefined => {
    const v = l.byId.get(id);
    if (!v) return t('batch.why.gone');
    if (v.locked) return t('batch.why.closed');
    if (which === 'findPayment' && v.none) return t('batch.why.notReceipt');
    if (which === 'findPayment' && v.links.length) return t('batch.why.linked');
    return undefined;
  };
  const takes = rows.filter((r) => !why(r.id)).map((r) => r.id);
  const cut = which === 'readAgain' ? takes.slice(READ_AGAIN_MAX) : [];
  const ids = which === 'readAgain' ? takes.slice(0, READ_AGAIN_MAX) : takes;
  const left = new Map<string, string[]>();
  for (const r of rows) { const w = why(r.id); if (w) left.set(w, [...(left.get(w) ?? []), r.title]); }
  if (cut.length) left.set(t('batch.why.readLimit', { max: READ_AGAIN_MAX }), cut.map(name));
  const change: Line[] = ids.length ? [{ n: ids.length, text: t(LINE[which]), names: ids.map(name) }] : [];
  const leftOut: Line[] = [...left].map(([text, names]) => ({ n: names.length, text, names }));

  async function run() {
    if (busy) return;
    setBusy(true);
    if (which === 'findPayment') {
      await runEach(nav, ids, async (id) => {
        const found = await api.findPayment(id);
        if (found.outcome === 'linked') return () => api.removeMapping({ receiptId: found.receipt, transactionRef: found.payment });
        if (found.outcome === 'filed') return () => api.setFiledPayment(found.receipt, null);
        return undefined;
      }, { done: (n) => t('batch.foundDone', { n }), name });
    } else if (which === 'readAgain') {
      await runEach(nav, ids, async (id) => { await api.visionExtract(id); return undefined; }, { done: (n) => t('batch.readDone', { n }), name });
    } else {
      await runEach(nav, ids, async (id) => { const deletion = await api.deleteReceipt(id); return () => api.restoreReceipt(id, deletion); }, { done: (n) => t('batch.deleteDone', { n }), name });
    }
    setBusy(false);
    onClose();
  }

  return (
    <div className="batchform" data-batch={which}>
      <PreviewLines change={change} left={leftOut} kind="receipt" />
      {which === 'readAgain' && <p className="m">{t('batch.readAgainNote')}</p>}
      <div className="acts">
        <button type="button" className={`btn primary${which === 'delete' ? ' danger' : ''}`} data-act="batch-run" disabled={!ids.length || busy} onClick={() => void run()}>
          {t(which === 'delete' ? 'batch.runDelete' : 'batch.run', { n: ids.length })}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}

/**
 * «Regel daraus»: the rule form of Firma › Regeln opened from the first picked payment's business
 * or payer (GET /api/rules/hand); its card shows every payment the rule would match before it is
 * kept, so a selection of several businesses is said, not guessed.
 */
function RuleFromSelection({ rows, nav, onClose }: { rows: SelRow[]; nav: Nav; onClose(): void }) {
  const names = [...new Set(rows.map((r) => r.title))];
  const first = rows.find((r) => !r.closed) ?? rows[0];
  return (
    <div className="batchform" data-batch="rule">
      <p>{names.length > 1 ? t('batch.ruleMany', { name: first.title, n: names.length }) : t('batch.ruleOne', { name: first.title })}</p>
      <div className="acts">
        <button type="button" className="btn primary" data-act="batch-run" onClick={() => { onClose(); nav.go({ route: { area: 'company', section: 'rules' }, query: { payment: first.id } }); }}>{t('batch.ruleOpen')}</button>
        <button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}
