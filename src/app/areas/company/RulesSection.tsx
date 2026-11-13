/**
 * Firma › Regeln: every rule of the company in plain words, where it came from and how often it
 * applied, with «Ausschalten» and «Löschen» (each with an undo in the toast), and «Neue Regel»: a
 * rule made by hand, without the AI (r8k-4). RuleDraft is the card of a drafted rule (the AI's, the
 * form's, «Immer so?»): the sidebar, Änderungen and the form show it, «Behalten» saves it at once.
 */
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { isKey, language, t } from '../../i18n/index.js';
import { textIn } from '../../../workflows/model.js';
import { api, errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import type { RuleRow } from '../../../booking/rule-book.js';
import type { RuleNames, RuleWords } from '../../../booking/rules.js';
import type { RuleLine } from '../../../booking/classify.js';
import type { PreviewPayment, RulePreview } from '../../../booking/rule-preview.js';
import type { DraftView, KeepResult, KeptView, RulesView } from '../../../saving/rules.js';
import { Go } from '../vat/links.js';
import { at } from '../receipts/view.js';
import type { NoteOffer, NoteReason } from '../../../knowledge/note-rules.js';
import type { ShareOffer } from '../../../saving/share-rule.js';
import type { GroupedOffer as GroupedOfferView } from '../../../saving/grouped-flag.js';
import type { CorrectionOffer as CorrectionOfferView } from '../../../saving/correction-rule.js';
import type { Nav } from '../index.js';
import { lineOf, namesOf, refusalKey, ruleLines } from './rules-model.js';
import { emptyForm, handRuleOf, type HandForm } from './hand-rule-model.js';
import { firmCodes } from '../../../accounting/vat-codes.js';
import { withoutInputTax } from '../../../engines/index.js';
import { VatCodeField } from '../codes/VatCodeField.js';
import { codeLabel } from '../codes/names.js';
import { announceBooksChanged, onBooksChanged } from '../../assistant/store.js';
import { AccountField } from '../journal/AccountField.js';
import type { HandSeed } from '../journal/rule-seed.js';
import type { WageOffer } from '../../../saving/wage-rule.js';

/** The page reads the books again: through its nav, or, from the AI sidebar's card, as after an answer. */
const refreshFor = (nav?: Nav) => { if (nav) nav.refresh(); else announceBooksChanged(); };

const words = ((key: string, vars: Record<string, string>) => (t as (k: string, v: Record<string, string>) => string)(key, vars)) as RuleWords;
const money = (n: number) => fmt(n).replace(/\.00$/, '');

function origin(r: RuleRow): string {
  // «decision 2026-01-12» of the demo's own rules in words, not as the file writes it (r9k-13).
  const decision = r.source && /^decision (\d{4}-\d{2}-\d{2})$/.exec(r.source);
  if (decision) return t('rules.from.decision', { date: formatDate(decision[1]) });
  if (r.origin === 'other') return r.source ? t('rules.from.other', { source: r.source }) : t('rules.from.unknown');
  return t(`rules.from.${r.origin}`);
}

const refusalText = (r: RuleRow) => (r.kind === 'note' ? t('rules.refuse.prose') : r.refusal ? (() => { const k = refusalKey(r.refusal); return t(k.key, k.vars as never); })() : '');

export function RulesSection({ nav, canEdit, payment, by }: { nav: Nav; canEdit: boolean; payment?: string; by?: 'text' }) {
  const [view, setView] = useState<RulesView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const reload = () => { api.rules().then(setView, (e) => setError(errorText(e))); };
  useEffect(reload, []);
  if (error) return <p className="warnline">{error}</p>;
  if (!view) return <p className="m">{t('changes.loading')}</p>;
  const lines = ruleLines(view, words, money, codeLabel);

  const act = async (row: RuleRow, kind: 'off' | 'on' | 'delete') => {
    setBusy(true);
    try {
      const r = await api.ruleCommand({ kind, file: row.file, step: row.step, id: row.id });
      if (!r.ok) { nav.toast(r.message); return; }
      reload();
      const undo = r.undo;
      nav.toast(t(`rules.done.${kind}`), undo && (() => {
        api.ruleCommand({ kind: 'restore', ...undo }).then((x) => { if (!x.ok) nav.toast(x.message); reload(); }, (e) => nav.toast(errorText(e)));
      }));
    } catch (e) {
      nav.toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rules">
      <p className="m">{t('rules.lead')}</p>
      <LastKept nav={nav} canEdit={canEdit} />
      {canEdit ? <HandRuleForm key={`${payment ?? ''}-${by ?? ''}`} view={view} nav={nav} payment={payment} by={by} onKept={reload} /> : null}
      {view.waiting.map((w) => (
        <p key={w.workflow} className="warnline" data-testid="rules-waiting">
          {t('rules.waiting', { files: w.files.join(', '), workflow: textIn(w.label, language()) })}
          {' '}
          <button type="button" className="linkbtn" onClick={() => nav.go({ route: { area: 'automation', view: 'workflow', workflow: w.workflow, tab: 'graph' }, query: {} })}>{t('rules.goSwitchOn')}</button>
        </p>
      ))}
      {!lines.length ? <p className="m">{t('rules.none')}</p> : null}
      <ul className="rulelist">
        {lines.map(({ key, row, line, acts, applied, last, asked }) => (
          <li key={key} className={`rule${row.off ? ' off' : ''}${acts ? '' : ' note'}`} data-rule={row.id}>
            <b className="ruleline">{line}</b>
            <span className="m">
              {origin(row)}
              {' · '}
              {!acts ? t('rules.noteOnly') : [
                applied ? t('rules.applied', { n: applied, date: formatDate(last) }) : asked ? '' : t('rules.neverApplied'),
                asked ? t('rules.asked', { n: asked }) : '',
              ].filter(Boolean).join(' · ')}
            </span>
            {row.kind === 'broken' ? <span className="warnline">{refusalText(row)}</span> : null}
            <span className="ruleacts">
              {row.off ? <span className="wfpill muted">{t('rules.isOff')}</span> : null}
              {!row.off && view.waiting.some((w) => w.files.includes(row.file)) ? <span className="wfpill warn">{t('rules.waitingPill')}</span> : null}
              {canEdit && row.kind === 'rule' ? <button type="button" className="btn ghost" disabled={busy} onClick={() => void act(row, row.off ? 'on' : 'off')}>{t(row.off ? 'rules.switchOn' : 'rules.switchOff')}</button> : null}
              {canEdit ? <button type="button" className="btn ghost" disabled={busy} onClick={() => void act(row, 'delete')}>{t('rules.delete')}</button> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}


/**
 * «Neue Regel»: whose payments (a business the firm knows, a payer, a text), optionally the
 * direction and amount, and the account and VAT code. «Vorschau» drafts the rule and shows its
 * card, with the payments it matches, before anything is kept. A firm without VAT codes sees no
 * VAT field. Opened from a payment (?payment=, or `inline` under a task), the form starts with that
 * payment's business or payer, and with what the hand form held (`seed`). The account is the same
 * field as the hand form's: a word or a hint finds it (AccountField, #383).
 */
function HandRuleForm({ view, nav, payment, by, seed, inline, onKept }: { view: RulesView; nav: Nav; payment?: string; by?: 'text'; seed?: HandSeed; inline?: { onClose(): void }; onKept(): void }) {
  const [open, setOpen] = useState(!!payment);
  const [f, setF] = useState<HandForm>(emptyForm());
  const [path, setPath] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  // The VAT and account fields keep what is typed; a form started from a payment draws them afresh.
  const [started, setStarted] = useState(0);
  useEffect(() => {
    if (!payment) return;
    api.handStart(payment, by).then((r) => { setF({ ...emptyForm(r.start), ...withSeed(seed) }); setStarted((n) => n + 1); }, () => undefined);
  }, [payment, by]);
  const codes = firmCodes();
  const set = (k: keyof HandForm) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const reset = () => { setOpen(false); setPath(undefined); setError(undefined); setF(emptyForm()); if (inline) inline.onClose(); else if (payment) nav.setQuery({}); };
  // Kept: the list shows the rule, and what the keep booked stands above it (LastKept); discarded: back to the form as typed.
  if (path) return <RuleDraft path={path} nav={nav} title={t('rules.hand.title')} onDone={(d, kept) => { if (d === 'discarded') { setPath(undefined); return; } afterKeep(kept, nav); onKept(); reset(); }} />;
  if (!open) return <p><button type="button" className="btn" data-testid="rule-new" onClick={() => setOpen(true)}>{t('rules.hand.new')}</button></p>;
  async function preview(e: FormEvent) {
    e.preventDefault();
    const account = String((form.current ? new FormData(form.current).get('account') : f.account) ?? '');
    // The form keeps the account it was previewed with: «Verwerfen» on the card brings it back as typed.
    setF((was) => ({ ...was, account }));
    const made = handRuleOf({ ...f, account });
    if (!made.ok) { setError(t(`rules.hand.missing.${made.missing}`)); return; }
    setBusy(true);
    setError(undefined);
    try { setPath((await api.draftHand(made.rule)).path); } catch (x) { setError(errorText(x)); } finally { setBusy(false); }
  }
  const businesses = Object.entries(view.names.businesses).sort((a, b) => a[1].localeCompare(b[1]));
  return (
    <form ref={form} className="form inline handrule" data-testid="rule-form" autoComplete="off" onSubmit={preview} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); reset(); } }}>
      <label>{t('rules.hand.match')}
        <select value={f.match} onChange={set('match')}>
          {businesses.length ? <option value="business">{t('rules.hand.byBusiness')}</option> : null}
          <option value="payer">{t('rules.hand.byPayer')}</option>
          <option value="text">{t('rules.hand.byText')}</option>
        </select>
      </label>
      {f.match === 'business' ? (
        <label className="wide">{t('rules.hand.business')}
          <select value={f.business} onChange={set('business')}>
            <option value="">{t('rules.hand.choose')}</option>
            {businesses.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      ) : f.match === 'payer' ? (
        <label className="wide">{t('rules.hand.payer')}<input className="mono" value={f.payer} onChange={set('payer')} autoFocus /></label>
      ) : (
        <label className="wide">{t('rules.hand.text')}<input value={f.text} onChange={set('text')} autoFocus /></label>
      )}
      <label>{t('rules.hand.direction')}
        <select value={f.direction} onChange={set('direction')}>
          <option value="">{t('rules.hand.both')}</option>
          <option value="in">{t('rules.hand.in')}</option>
          <option value="out">{t('rules.hand.out')}</option>
        </select>
      </label>
      <label>{t('rules.hand.over', { currency: view.currency })}<input className="mono" inputMode="decimal" value={f.over} onChange={set('over')} /></label>
      <label>{t('rules.hand.under', { currency: view.currency })}<input className="mono" inputMode="decimal" value={f.under} onChange={set('under')} /></label>
      <AccountField key={`account-${started}`} name="account" label={t('rules.hand.account')} defaultValue={f.account} prefer={f.direction === 'in' ? 'revenue' : f.direction === 'out' ? 'expense' : undefined} />
      {codes.length ? (
        <VatCodeField key={`vat-${started}`} name="vat" label={t('rules.hand.vat')} defaultValue={f.vat} placeholder={t('rules.hand.vatFromReceipts')} onValue={(vat) => setF((was) => ({ ...was, vat }))} />
      ) : null}
      <label>{t('rules.hand.private')}<input className="mono" inputMode="decimal" data-testid="rule-share" value={f.share} onChange={set('share')} /></label>
      {codes.length && !withoutInputTax() && f.share.trim() ? (
        <label><input type="checkbox" data-testid="rule-own-use" checked={f.ownUse} onChange={(e) => setF({ ...f, ownUse: e.target.checked })} /> {t('rules.hand.ownUse')}</label>
      ) : null}
      {(view.names.dimensions ?? []).map((d) => (
        <label key={d.id} data-dimension={d.id}>{d.label}
          <input list={`rule-tag-${d.id}`} value={f.tags[d.id] ?? ''} placeholder={t('tags.none')} onChange={(e) => setF({ ...f, tags: { ...f.tags, [d.id]: e.target.value } })} />
          <datalist id={`rule-tag-${d.id}`}>{d.values.filter((v) => v.active).map((v) => <option key={v.value} value={v.value}>{v.label ?? ''}</option>)}</datalist>
        </label>
      ))}
      {error ? <span className="warnline wide">{error}</span> : null}
      <div className="acts">
        <button type="submit" className="btn primary" disabled={busy}>{t('rules.hand.preview')}</button>
        <button type="button" className="btn ghost" onClick={reset}>{t('common.cancel')}</button>
        <span className="m">{t('rules.hand.hint')}</span>
      </div>
    </form>
  );
}

/** The seed's values as the form holds them; an empty one leaves the start's. */
const withSeed = (seed?: HandSeed): Partial<HandForm> => ({
  ...(seed?.account ? { account: seed.account } : {}),
  ...(seed?.vat ? { vat: seed.vat } : {}),
  ...(seed?.share ? { share: seed.share } : {}),
});

/**
 * The rule form started from a payment right where it is (a task, a payment's detail), with what
 * the hand form held: nothing is lost, and keeping or discarding brings the person back to the
 * same place (#383). What the keep booked stays named above the tasks (LastKept).
 */
export function RuleFromPayment({ nav, payment, by, seed, onClose }: { nav: Nav; payment: string; by?: 'text'; seed?: HandSeed; onClose(): void }) {
  const [view, setView] = useState<RulesView>();
  const [error, setError] = useState<string>();
  useEffect(() => { api.rules().then(setView, (e) => setError(errorText(e))); }, []);
  if (error) return <p className="warnline">{error}</p>;
  if (!view) return <p className="m">{t('changes.loading')}</p>;
  return (
    <div className="rulefrom" data-testid="rule-from-payment">
      <HandRuleForm view={view} nav={nav} payment={payment} by={by} seed={seed} inline={{ onClose }} onKept={() => undefined} />
    </div>
  );
}

/**
 * The result lines of the keeps, as the server recorded them (#396): one per keep, read again after
 * every keep and undo, so a reload shows them as well. A line taken back keeps what its undo said
 * until closed.
 */
let keptLines: KeptView[] = [];
const keptSaid = new Map<string, string>();
const keptListeners = new Set<() => void>();
const keptChanged = () => { keptLines = [...keptLines]; for (const f of keptListeners) f(); };
const onKeptChange = (f: () => void) => { keptListeners.add(f); return () => { keptListeners.delete(f); }; };
function reloadKept(): void {
  api.keptLines().then((r) => {
    const undone = keptLines.filter((k) => keptSaid.has(k.id) && !r.kept.some((x) => x.id === k.id));
    keptLines = [...undone, ...r.kept].sort((a, b) => a.at.localeCompare(b.at));
    keptChanged();
  }, () => undefined);
}
/** A keep's answer: every keep has its line above the lists (one that booked nothing too: it may hold an earlier keep's undo). */
function afterKeep(kept: Kept | undefined, nav: Nav): void {
  if (kept?.keep) reloadKept();
  else nav.toast(t('rules.draft.kept'));
}

/** What each rule kept booked, until its line is closed: the tasks it booked are gone from the list, so the result stands above it. */
export function LastKept({ nav, canEdit }: { nav: Nav; canEdit: boolean }) {
  const lines = useSyncExternalStore(onKeptChange, () => keptLines);
  // A keep or an undo on another card (the AI sidebar's) changes the lines too.
  useEffect(() => { if (!canEdit) return; reloadKept(); return onBooksChanged(reloadKept); }, [canEdit]);
  if (!canEdit || !lines.length) return null;
  const close = (id: string) => {
    keptLines = keptLines.filter((k) => k.id !== id);
    keptSaid.delete(id);
    keptChanged();
    api.closeKept(id).then(reloadKept, () => undefined);
  };
  // A line that holds an earlier keep's undo stays: the earlier line names it and takes both back.
  const holds = (id: string) => lines.some((x) => !x.ended && !keptSaid.has(x.id) && x.blockedBy?.includes(id));
  return (
    <>
      {lines.map((k) => (
        <div key={k.id} className="ruledraft done" data-testid="last-kept" data-keep={k.id}>
          <KeptLine keep={k} nav={nav} lead />
          {holds(k.id) ? null : <span className="ruleacts"><button type="button" className="linkbtn" onClick={() => close(k.id)}>{t('common.close')}</button></span>}
        </div>
      ))}
    </>
  );
}

/**
 * The rule for the open wages, drafted by code (src/saving/wage-rule.ts, #383): one line above the
 * tasks, «Regel für alle 6», and the click shows the rule's card with its payments. One decision,
 * no form.
 */
export function WageRuleOffer({ nav, books }: { nav: Nav; books?: { journalEntries?: ReadonlyArray<{ transactionRef: string }> } }) {
  const [offer, setOffer] = useState<WageOffer | null>(null);
  const [path, setPath] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    const load = () => { api.wageOffer().then((x) => { if (live) setOffer(x.offer); }, () => { if (live) setOffer(null); }); };
    load();
    const off = onBooksChanged(load);
    return () => { live = false; off(); };
  }, [nav, books]);
  if (path) {
    return <RuleDraft path={path} nav={nav} title={t('rules.wages.title')} onDone={(d, kept) => { setPath(undefined); if (d !== 'discarded') { afterKeep(kept, nav); setOffer(null); } }} />;
  }
  // Only the wages open now count (r3-noai-23): one booked by hand meanwhile leaves the offer before the server is asked again.
  const booked = new Set(books?.journalEntries?.map((e) => e.transactionRef));
  const open = offer?.refs.filter((ref) => !booked.has(ref)) ?? [];
  if (!offer || !open.length) return null;
  const draft = () => {
    setBusy(true);
    setError(undefined);
    api.draftHand(offer.rule).then((r) => setPath(r.path), (e) => setError(errorText(e))).finally(() => setBusy(false));
  };
  return (
    <div className="ruledraft" data-testid="wage-rule-offer" data-n={open.length}>
      <b>{t('rules.wages.line', { n: open.length })}</b>
      <span className="m">{t('rules.wages.lead', { text: offer.text, account: offer.account })}</span>
      {error ? <span className="warnline">{error}</span> : null}
      <span className="ruleacts"><button type="button" className="btn primary" disabled={busy} data-act="wage-rule" onClick={draft}>{t('rules.wages.go', { n: open.length })}</button></span>
    </div>
  );
}

type Done = 'kept' | 'removedDone' | 'discarded';
/** A keep's answer: what it booked at once, what waits for a receipt, and the rules file as it was. */
type Kept = Extract<KeepResult, { ok: true }>;

/**
 * What keeping a rule did (#383, #396): «4 Zahlungen gebucht» with a link to the newest of the
 * bookings, «2 warten auf ihren Beleg», and «Rückgängig bis …»: the server puts the rules file back
 * and takes out the bookings the keep made that are still its own, naming what stays and why. A keep
 * a later keep of the same file holds names it and takes both back, newest first; one whose undo is
 * gone says why.
 */
export function KeptLine({ keep, nav, lead }: { keep: KeptView; nav?: Nav; lead?: boolean }) {
  const [said, setSaid] = useState<string | undefined>(keptSaid.get(keep.id));
  const [busy, setBusy] = useState(false);
  const k = keep;
  const b = k.booked;
  const say = (text: string) => { keptSaid.set(k.id, text); setSaid(text); };
  const undo = async (withLater = false) => {
    setBusy(true);
    try {
      const r = await api.undoKept(k.id, withLater);
      if (!r.ok) { setSaid(r.refusal && isKey(`rules.kept.ended.${r.refusal}`) ? t(`rules.kept.ended.${r.refusal}` as 'rules.kept.ended.file') : r.message); if (r.removed) refreshFor(nav); reloadKept(); return; }
      const left = [r.left.changed ? t('rules.kept.leftChanged', { n: r.left.changed }) : '', r.left.closed ? t('rules.kept.leftClosed', { n: r.left.closed }) : '', r.left.gone ? t('rules.kept.leftGone', { n: r.left.gone }) : '', r.left.other ? t('rules.kept.leftOther', { n: r.left.other }) : ''].filter(Boolean);
      say([t('rules.kept.undone', { n: r.removed }), ...left].join(' '));
      refreshFor(nav);
      reloadKept();
    } catch (e) { setSaid(errorText(e)); } finally { setBusy(false); }
  };
  const parts = [
    b.refs.length ? t('rules.kept.booked', { n: b.refs.length }) : '',
    b.running ? t('rules.kept.running', { n: b.running }) : '',
    k.waits ? t('rules.kept.waits', { n: k.waits }) : '',
    b.notBooked.length ? t('rules.kept.notBooked', { n: b.notBooked.length }) : '',
    b.later ? t('rules.kept.later', { n: b.later }) : '',
  ].filter(Boolean);
  // Nothing booked, something waiting: the line says so, not only what waits (r3-ai-29).
  if (!b.refs.length && !b.running && parts.length) parts.unshift(t('rules.kept.none'));
  return (
    <span className="keptline" data-testid="rule-kept" data-keep={k.id} data-booked={b.refs.length} data-waits={k.waits} data-running={b.running}>
      {said ? <span>{said}</span> : (
        <>
          {lead ? <span className="m">{t('rules.draft.keptNow')}</span> : null}
          {parts.length ? <span>{parts.join(' · ')}</span> : null}
          {b.first && nav ? <Go to={at({ area: 'journal', id: b.first.id }, b.first.date)} nav={nav} className="golink">{t('rules.kept.show')}</Go> : null}
          {k.ended
            ? <span className="m" data-testid="rule-undo-gone" data-ended={k.ended}>{t(`rules.kept.ended.${k.ended}`)}</span>
            : k.blockedBy?.length
              ? (
                <>
                  <span className="m" data-testid="rule-undo-later">{t('rules.kept.blockedBy', { n: k.blockedBy.length })}</span>
                  <button type="button" className="linkbtn" data-act="rule-undo-all" disabled={busy} onClick={() => void undo(true)}>{t('rules.kept.undoAll', { n: k.blockedBy.length + 1 })}</button>
                </>
              )
              : <button type="button" className="linkbtn" data-act="rule-undo" disabled={busy} onClick={() => void undo()}>{t('rules.kept.undoUntil', { date: formatDate(k.until) })}</button>}
        </>
      )}
    </span>
  );
}

/** A booking line as the card names it: account and name, VAT code, amount. */
const accountText = (n: string, names: RuleNames) => (names.account(n) ? `${n} ${names.account(n)}` : n);
/** A booking line as the card names it; a line without the bank (an own-use correction) with both its accounts. */
const lineText = (l: RuleLine, names: RuleNames) => [l.against ? `${accountText(l.account, names)} / ${accountText(l.against, names)}` : accountText(l.account, names), l.vat && codeLabel(l.vat), fmt(l.amount)].filter(Boolean).join(' · ');

function PaymentLine({ p, names, national }: { p: PreviewPayment; names: RuleNames; national?: RuleLine[] }) {
  const would = p.would.lines.map((l) => lineText(l, names)).join(' + ');
  return (
    <li data-waits={p.waits ? 'receipt' : undefined}>
      <span className="m">{formatDate(p.date)} · {p.currency} {fmt(p.amount)}</span> {p.text}
      {' → '}
      {/* A payment that waits for its receipt is not booked at the keep: the card says what keeping will do (#383). */}
      <b>{p.would.kind === 'ask' ? t('rules.preview.ask', { question: p.would.question }) : p.reconcile ? t('rules.preview.reconcile') : p.waits ? t('rules.preview.waits') : would}</b>
      <span className="m">{' · '}{p.decidedBy ? t('rules.preview.otherFirst') : p.now.length ? t('rules.preview.now', { booking: p.now.map((l) => lineText(l, names)).join(' + ') }) : t('rules.preview.unbooked')}</span>
      {p.beforeAi && !p.decidedBy ? <span className="m" data-testid="before-ai">{' · '}{t('rules.preview.beforeAi', { booking: p.beforeAi.map((l) => lineText(l, names)).join(' + ') })}</span> : null}
      {national ? <span className="m" data-testid="national">{' · '}{t('rules.preview.national', { booking: national.map((l) => (l.vat ? codeLabel(l.vat) : '–')).join(' + ') })}</span> : null}
    </li>
  );
}

/** What one drafted rule would do on this year's payments, and the rules it meets there. */
function Preview({ p, names }: { p: RulePreview; names: RuleNames }) {
  // A payment booked against a national VAT rule says, on its own line, which code that rule gives.
  const national = new Map(p.overrides?.flatMap((o) => o.payments.map((x) => [x.ref, x.national] as const)));
  const shown = new Set(p.examples.map((x) => x.ref));
  return (
    <div className="rulepreview" data-preview={p.key}>
      <span className="m">{p.matches ? t('rules.preview.matches', { n: p.matches, year: p.year }) : t('rules.preview.none', { year: p.year })}</span>
      {p.examples.length ? <ul>{p.examples.map((x) => <PaymentLine key={x.ref} p={x} names={names} national={national.get(x.ref)} />)}</ul> : null}
      {p.matches > p.examples.length ? <span className="m">{t('rules.preview.more', { n: p.matches - p.examples.length })}</span> : null}
      {p.open && (p.open.book.length || p.open.waits.length || p.open.reconcile?.length) ? (
        <span className="m" data-testid="rule-open" data-book={p.open.book.length} data-waits={p.open.waits.length} data-reconcile={p.open.reconcile?.length ?? 0}>
          {[p.open.book.length ? t('rules.preview.openBook', { n: p.open.book.length }) : '', p.open.waits.length ? t('rules.preview.openWaits', { n: p.open.waits.length }) : '', p.open.reconcile?.length ? t('rules.preview.openReconcile', { n: p.open.reconcile.length }) : ''].filter(Boolean).join(' ')}
        </span>
      ) : null}
      {p.overlaps.map((o) => (
        <span key={`${o.row.file}#${o.row.step}#${o.row.id}`} className="warnline">
          {t('rules.preview.overlap', { n: o.shared, line: lineOf(o.row, names, words) })}
          {o.theirs ? ` ${t('rules.preview.theirs', { n: o.theirs })}` : ''}
        </span>
      ))}
      {p.otherwise && p.same ? (
        <>
          <span className="m" data-testid="rule-holds">{t('rules.preview.holds', { n: p.otherwise, same: String(p.same), all: String(p.same + p.otherwise) })}</span>
          {p.differ?.length ? <ul>{p.differ.map((x) => <PaymentLine key={x.ref} p={x} names={names} />)}</ul> : null}
        </>
      ) : null}
      {p.loneWords.length ? <span className="warnline">{t('rules.preview.wide', { words: p.loneWords.map((w) => `«${w}»`).join(', ') })}</span> : null}
      {p.spread ? (
        <>
          <span className="warnline" data-testid="rule-spread">{t(p.spread.private ? 'rules.preview.spreadPrivate' : 'rules.preview.spread', { accounts: p.spread.accounts.map((a) => (names.account(a) ? `${a} ${names.account(a)}` : a)).join(', ') })}</span>
          {p.spread.payments.length ? <ul>{p.spread.payments.map((x) => <PaymentLine key={x.ref} p={x} names={names} />)}</ul> : null}
        </>
      ) : null}
      {p.overrides?.map((o) => {
        const others = o.payments.filter((x) => !shown.has(x.ref));
        return (
          <Fragment key={o.kind}>
            <span className="warnline" data-testid="rule-override" data-override={o.kind}>{t(`rules.preview.override.${o.kind}`, { n: o.count })} {t('rules.preview.overrideKeep')}</span>
            {others.length ? <ul>{others.map((x) => <PaymentLine key={x.ref} p={x} names={names} national={x.national} />)}</ul> : null}
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * The card of one drafted rules file: each added, changed or removed rule in one plain line, then
 * «Behalten» (or «Ja, entfernen» for a removal) and «Verwerfen». A rule the app cannot carry out
 * is named with its reason and cannot be kept; a rule whose VAT the receipts leave open asks for
 * it once, with the rates to choose from. A draft that holds no rule shows nothing. `reveal`: the
 * card scrolls itself into view whenever it loads (the AI sidebar, where it appears under an answer).
 */
export function RuleDraft({ path, nav, onRules, onDone, title, reveal }: { path: string; nav?: Nav; onRules?(): void; onDone?(done: Done, kept?: Kept): void; title?: string; reveal?: boolean }) {
  const [d, setD] = useState<DraftView | null>();
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => { if (reveal && d) card.current?.scrollIntoView({ block: 'nearest' }); }, [reveal, d?.basis]);
  const [done, setDone] = useState<Done>();
  const [kept, setKept] = useState<Kept>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const load = () => { api.draftRules(path).then(setD, () => setD(null)); };
    load();
    // An answer's changes taken or undone change what the card's payments are booked on today.
    return onBooksChanged(load);
  }, [path]);
  if (done) {
    return (
      <div className="ruledraft done" data-draft={path}>
        {/* Booked or waiting: «Deine Regel ist behalten.» and its result line; nothing open: it holds from the next payment on. */}
        <span>{kept?.keep && done === 'kept' && (kept.keep.booked.refs.length || kept.keep.waits) ? t('rules.draft.keptNow') : t(`rules.draft.${done}`)}</span>
        {done !== 'discarded' && onRules ? <button type="button" className="linkbtn" onClick={onRules}>{t('rules.draft.toRules')}</button> : null}
        {kept?.keep ? <KeptLine keep={kept.keep} nav={nav} /> : null}
      </div>
    );
  }
  if (!d) return null;
  const names = namesOf(d, money, codeLabel);
  const say = (r: RuleRow) => lineOf(r, names, words);
  const onlyRemoval = !d.added.length && !d.changed.length && d.removed.length > 0;
  const go = async (kind: 'keep' | 'discard') => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.draftCommand(kind === 'keep' ? { kind, path, basis: d.basis, confirm: d.confirm } : { kind, path });
      if (r.ok) {
        const done = kind === 'discard' ? 'discarded' : onlyRemoval ? 'removedDone' : 'kept';
        // What the keep booked at once, what waits for a receipt, and its undo (#383, #396): the card says so where it stood, the sidebar too.
        const result = 'committed' in r && r.keep ? r as Kept : undefined;
        if (result) { setKept(result); refreshFor(nav); }
        if (onDone) onDone(done, result); else setDone(done);
      }
      else setError('message' in r ? r.message : t('rules.draft.gone'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const chooseVat = async (step: string, id: string, rate: number) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.draftCommand({ kind: 'vat', path, basis: d.basis, step, id, rate });
      if (r.ok) setD(await api.draftRules(path));
      else setError('message' in r ? r.message : t('rules.draft.gone'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const asked = (r: RuleRow) => d.vatAsks.some((a) => a.step === r.step && a.id === r.id);
  const business = d.path.startsWith('knowledge/rules/') ? undefined : d.path.split('/').pop()!.replace(/\.yaml$/, '');
  return (
    <div className="ruledraft" data-draft={path} ref={card}>
      <span className="m">{title ?? t('rules.draft.title')}</span>
      <ul>
        {d.added.map((r) => <li key={`a${r.step}${r.id}`}><span className="rk">{t('rules.draft.added')}</span> <b>{say(r)}</b></li>)}
        {d.changed.map((r, i) => (
          <li key={`c${r.step}${r.id}`}>
            <span className="rk">{t('rules.draft.changed')}</span> {t('rules.draft.was', { line: say(d.before[i]) })}
            <br /><span className="rk">{t('rules.draft.becomes')}</span> <b>{say(r)}</b>
          </li>
        ))}
        {d.grouped !== undefined && business ? <li key="grouped" data-testid="draft-grouped"><span className="rk">{t(d.grouped ? 'rules.draft.added' : 'rules.draft.removed')}</span> <b>{t('rules.grouped.line', { name: names.business(business) ?? business })}</b></li> : null}
        {d.removed.map((r) => (
          <li key={`r${r.step}${r.id}`}>
            <span className="rk">{t('rules.draft.removed')}</span> <b>{say(r)}</b>
            {d.held[r.id] ? <span className="m"> {t('rules.draft.held', { n: d.held[r.id] })}</span> : null}
          </li>
        ))}
      </ul>
      {d.preview.map((p) => <Preview key={p.key} p={p} names={names} />)}
      {[...d.added, ...d.changed].map((r) => {
        const offer = d.offers[`${r.step}#${r.id}`];
        return offer && r.rule?.note ? <NoteOfferLine key={`n${r.step}${r.id}`} row={r} offer={offer} onDrafted={() => void api.draftRules(path).then(setD, () => setD(null))} /> : null;
      })}
      {d.others && business ? <span className="m">{t('rules.draft.others', { name: names.business(business) ?? business })}</span> : null}
      {d.broken ? <span className="warnline">{t('rules.draft.broken', { why: d.broken })}</span> : null}
      {d.vatAsks.map((a) => (
        <div key={`v${a.step}${a.id}`} className="vatask" data-vat-ask={a.id}>
          <span>{a.seen.length ? t('rules.draft.vatAsk.mixed', { seen: a.seen.map((s) => t('rules.draft.vatSeen', { rate: s.rate ? t('rules.draft.vatRate', { rate: String(s.rate) }) : t('rules.draft.vatZero'), n: String(s.receipts) })).join(', ') }) : t('rules.draft.vatAsk.none')}</span>
          <span className="m">{t('rules.draft.vatAsk.how')}</span>
          <span className="ruleacts">
            {a.choices.map((rate) => <button key={rate} type="button" className="btn ghost" disabled={busy} onClick={() => void chooseVat(a.step, a.id, rate)}>{rate ? t('rules.draft.vatRate', { rate: String(rate) }) : t('rules.draft.vatZero')}</button>)}
          </span>
        </div>
      ))}
      {d.refused.filter((r) => !asked(r)).map((r) => <span key={`x${r.id}`} className="warnline">{t('rules.draft.refused', { id: r.id || '?', why: refusalText(r) })}</span>)}
      {error ? <span className="warnline">{error}</span> : null}
      <span className="ruleacts">
        {d.keepable ? <button type="button" className="btn primary" disabled={busy} onClick={() => void go('keep')}>{t(onlyRemoval ? 'rules.draft.remove' : d.confirm ? 'rules.draft.keepAnyway' : 'rules.draft.keep')}</button> : null}
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void go('discard')}>{t('rules.draft.discard')}</button>
        {nav && !d.keepable && !d.vatAsks.length ? <button type="button" className="linkbtn" onClick={() => nav.go({ route: { area: 'changes', commit: 'draft', file: path }, query: {} })}>{t('rules.draft.diff')}</button> : null}
      </span>
    </div>
  );
}

/** Why a rule from the notes is not offered, in words. */
const reasonText = (w: NoteReason) => (w.code === 'openChoice' ? t('rules.note.why.openChoice', { words: w.words.map((x) => `«${x}»`).join(', ') })
  : w.code === 'bookedOtherwise' ? t('rules.note.why.bookedOtherwise', { n: w.n })
    : w.code === 'alreadySaid' ? t('rules.note.why.alreadySaid', { rule: w.rule }) : t('rules.note.why.notOnePartner'));

/**
 * A rule drafted from a sentence of the notes: the sentence it quotes, and, when code does not offer
 * it as drafted, why (src/knowledge/note-rules.ts): it stays a note, or only an ask rule may carry it
 * out, which «Als Frage-Regel entwerfen» drafts. A rule adjusted to its changed sentence says how
 * many of this year's payments it would book otherwise than they are booked.
 */
function NoteOfferLine({ row, offer, onDrafted }: { row: RuleRow; offer: NoteOffer; onDrafted(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const rule = row.rule!;
  const toAsk = async () => {
    const b = rule.then.booking;
    if (!b || !row.business) return;
    setBusy(true);
    try {
      await api.draftNoteRule({ partner: row.business, sentence: rule.note!, replaces: row.id, then: { account: b.account, vat: b.vat, ...(b.private ? { private: b.private } : {}), ask: t('rules.note.askQuestion', { sentence: rule.note! }) } });
      onDrafted();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="noteoffer" data-offer={offer.offer}>
      <span className="m">{t('rules.note.from', { sentence: rule.note! })}</span>
      {offer.offer !== 'rule' ? (
        <span className="warnline" data-testid="note-offer">{t(offer.offer === 'ask' ? 'rules.note.onlyAsk' : 'rules.note.stays')} {offer.why.map(reasonText).join(' ')}</span>
      ) : null}
      {offer.offer === 'rule' && offer.otherwise ? <span className="warnline" data-testid="note-rebooks">{t('rules.note.rebooks', { n: offer.otherwise })}</span> : null}
      {error ? <span className="warnline">{error}</span> : null}
      {offer.offer === 'ask' && row.business ? <span className="ruleacts"><button type="button" className="btn" disabled={busy} data-act="note-to-ask" onClick={() => void toAsk()}>{t('rules.note.toAsk')}</button></span> : null}
    </div>
  );
}

/** One «Immer so?»: the split as a rule, drafted on the click and then shown on its card. */
function ShareOfferCard({ offer, onRules }: { offer: ShareOffer; onRules?(): void }) {
  const [path, setPath] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (path) return <RuleDraft path={path} onRules={onRules} />;
  const who = offer.business?.name ?? t('rules.share.payer', { payer: offer.payerName ?? offer.payer ?? '' });
  const draft = () => {
    setBusy(true);
    api.draftShare(offer.ref).then((r) => setPath(r.path), (e) => setError(errorText(e))).finally(() => setBusy(false));
  };
  return (
    <div className="ruledraft" data-share={offer.ref}>
      <span>{offer.setup
        ? t(`rules.share.askSetup.${offer.setup.item}`, { who, percent: String(offer.percent), account: offer.booking.account, said: offer.setup.said })
        : t(offer.booking.ownUse ? 'rules.share.askOwnUse' : 'rules.share.ask', { who, percent: String(offer.percent), account: offer.booking.account })}</span>
      {error ? <span className="warnline">{error}</span> : null}
      <span className="ruleacts"><button type="button" className="btn" disabled={busy} onClick={draft}>{t('rules.share.draft')}</button></span>
    </div>
  );
}

/**
 * «Immer so?» under several receipts a person linked to one payment, the second time (#190): the
 * business as a batch payer, drafted on the click and then shown on its card. Nothing while the
 * payment offers none.
 */
export function GroupedOffer({ payment, onRules }: { payment: string; onRules?(): void }) {
  const [offer, setOffer] = useState<GroupedOfferView | null>(null);
  const [path, setPath] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    const load = () => { api.groupedOffer(payment).then((x) => { if (live) setOffer(x.offer); }, () => { if (live) setOffer(null); }); };
    load();
    const off = onBooksChanged(load);
    return () => { live = false; off(); };
  }, [payment]);
  if (path) return <RuleDraft path={path} onRules={onRules} />;
  if (!offer) return null;
  const draft = () => {
    setBusy(true);
    api.draftGrouped(offer.ref).then((r) => setPath(r.path), (e) => setError(errorText(e))).finally(() => setBusy(false));
  };
  return (
    <div className="ruledraft" data-grouped={offer.ref}>
      <span>{t('rules.grouped.ask', { name: offer.business.name, n: offer.payments })}</span>
      {error ? <span className="warnline">{error}</span> : null}
      <span className="ruleacts"><button type="button" className="btn" disabled={busy} data-testid="grouped-draft" onClick={draft}>{t('rules.grouped.draft')}</button></span>
    </div>
  );
}

/**
 * «Regel anpassen?» on a booking a person corrected after a rule made it (r9k-5): the rule's change
 * the correction teaches, drafted on the click and then shown on its card with the payments it
 * would book differently; «Behalten» keeps it. Nothing while the booking is still the rule's.
 */
export function CorrectionOffer({ payment, onRules }: { payment: string; onRules?(): void }) {
  const [offer, setOffer] = useState<CorrectionOfferView | null>(null);
  const [path, setPath] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    const load = () => { api.correctionOffer(payment).then((x) => { if (live) setOffer(x.offer); }, () => { if (live) setOffer(null); }); };
    load();
    const off = onBooksChanged(load);
    return () => { live = false; off(); };
  }, [payment]);
  if (path) return <RuleDraft path={path} onRules={onRules} title={t('rules.correction.title')} />;
  if (!offer) return null;
  const draft = () => {
    setBusy(true);
    api.draftCorrection(offer.ref).then((r) => setPath(r.path), (e) => setError(errorText(e))).finally(() => setBusy(false));
  };
  const who = offer.business?.name ?? offer.rule;
  return (
    <div className="ruledraft" data-correction={offer.ref}>
      <span>{t(offer.to.vat !== offer.from.vat ? 'rules.correction.askVat' : 'rules.correction.ask', { who, from: offer.from.account, to: offer.to.account, vat: offer.to.vat ? codeLabel(offer.to.vat) : t('journal.noVat') })}</span>
      {error ? <span className="warnline">{error}</span> : null}
      <span className="ruleacts"><button type="button" className="btn" disabled={busy} data-testid="correction-draft" onClick={draft}>{t('rules.correction.draft')}</button></span>
    </div>
  );
}

/**
 * «Immer so?» under an answer's changes (wishes3-6): each payment it split into a business part
 * and a private part offers the split as a rule; payments of one business with the same split
 * offer it once.
 */
export function ShareOffers({ refs, onRules, only }: { refs: string[]; onRules?(): void; only?: 'setup' }) {
  const [offers, setOffers] = useState<ShareOffer[]>([]);
  const key = refs.join(' ');
  useEffect(() => {
    let live = true;
    Promise.all(refs.map((r) => api.shareOffer(r).then((x) => x.offer, () => null))).then((xs) => {
      const one = new Map(xs.filter((o): o is ShareOffer => !!o && (!only || !!o.setup)).map((o) => [`${o.path}#${o.payer}#${o.percent}#${o.booking.account}`, o]));
      if (live) setOffers([...one.values()]);
    });
    return () => { live = false; };
  }, [key]);
  return <>{offers.map((o) => <ShareOfferCard key={o.ref} offer={o} onRules={onRules} />)}</>;
}
