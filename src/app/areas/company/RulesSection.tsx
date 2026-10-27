/**
 * Firma › Regeln: every rule of the company in plain words, where it came from and how often it
 * applied, with «Ausschalten» and «Löschen» (each with an undo in the toast), and «Neue Regel»: a
 * rule made by hand, without the AI (r8k-4). RuleDraft is the card of a drafted rule (the AI's, the
 * form's, «Immer so?»): the sidebar, Änderungen and the form show it, «Behalten» saves it at once.
 */
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { language, t } from '../../i18n/index.js';
import { textIn } from '../../../workflows/model.js';
import { api, errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import type { RuleRow } from '../../../booking/rule-book.js';
import type { RuleNames, RuleWords } from '../../../booking/rules.js';
import type { RuleLine } from '../../../booking/classify.js';
import type { PreviewPayment, RulePreview } from '../../../booking/rule-preview.js';
import type { DraftView, RulesView } from '../../../saving/rules.js';
import type { NoteOffer, NoteReason } from '../../../knowledge/note-rules.js';
import type { ShareOffer } from '../../../saving/share-rule.js';
import type { GroupedOffer as GroupedOfferView } from '../../../saving/grouped-flag.js';
import type { CorrectionOffer as CorrectionOfferView } from '../../../saving/correction-rule.js';
import type { Nav } from '../index.js';
import { lineOf, namesOf, refusalKey, ruleLines } from './rules-model.js';
import { emptyForm, handRuleOf, type HandForm } from './hand-rule-model.js';
import { firmCodes } from '../../../accounting/vat-codes.js';
import { onBooksChanged } from '../../assistant/store.js';

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

export function RulesSection({ nav, canEdit, payment }: { nav: Nav; canEdit: boolean; payment?: string }) {
  const [view, setView] = useState<RulesView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const reload = () => { api.rules().then(setView, (e) => setError(errorText(e))); };
  useEffect(reload, []);
  if (error) return <p className="warnline">{error}</p>;
  if (!view) return <p className="m">{t('changes.loading')}</p>;
  const lines = ruleLines(view, words, money);

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
      {canEdit ? <HandRuleForm key={payment ?? ''} view={view} nav={nav} payment={payment} onKept={reload} /> : null}
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
 * VAT field. Opened from a payment (?payment=), the form starts with that payment's business or payer.
 */
function HandRuleForm({ view, nav, payment, onKept }: { view: RulesView; nav: Nav; payment?: string; onKept(): void }) {
  const [open, setOpen] = useState(!!payment);
  const [f, setF] = useState<HandForm>(emptyForm());
  const [path, setPath] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!payment) return;
    api.handStart(payment).then((r) => setF(emptyForm(r.start)), () => undefined);
  }, [payment]);
  const codes = firmCodes();
  const set = (k: keyof HandForm) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const reset = () => { setOpen(false); setPath(undefined); setError(undefined); setF(emptyForm()); if (payment) nav.setQuery({}); };
  // Kept: the list shows the rule; discarded: back to the form as typed.
  if (path) return <RuleDraft path={path} nav={nav} title={t('rules.hand.title')} onDone={(d) => { if (d === 'discarded') { setPath(undefined); return; } nav.toast(t('rules.draft.kept')); onKept(); reset(); }} />;
  if (!open) return <p><button type="button" className="btn" data-testid="rule-new" onClick={() => setOpen(true)}>{t('rules.hand.new')}</button></p>;
  const made = handRuleOf(f);
  async function preview(e: FormEvent) {
    e.preventDefault();
    if (!made.ok) { setError(t(`rules.hand.missing.${made.missing}`)); return; }
    setBusy(true);
    setError(undefined);
    try { setPath((await api.draftHand(made.rule)).path); } catch (x) { setError(errorText(x)); } finally { setBusy(false); }
  }
  const businesses = Object.entries(view.names.businesses).sort((a, b) => a[1].localeCompare(b[1]));
  return (
    <form className="form inline handrule" data-testid="rule-form" onSubmit={preview} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); reset(); } }}>
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
      <label>{t('rules.hand.account')}<input className="mono" list="rule-accounts" value={f.account} onChange={set('account')} /></label>
      <datalist id="rule-accounts">{Object.entries(view.names.accounts).map(([n, name]) => <option key={n} value={n}>{name}</option>)}</datalist>
      {codes.length ? (
        <label>{t('rules.hand.vat')}
          <select value={f.vat} onChange={set('vat')}>
            <option value="">{t('rules.hand.noVat')}</option>
            {codes.map((c) => <option key={c.code} value={c.code}>{c.code}{c.bananaText ? ` · ${c.bananaText}` : ''}</option>)}
          </select>
        </label>
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

type Done = 'kept' | 'removedDone' | 'discarded';

/** A booking line as the card names it: account and name, VAT code, amount. */
const lineText = (l: RuleLine, names: RuleNames) => [names.account(l.account) ? `${l.account} ${names.account(l.account)}` : l.account, l.vat, fmt(l.amount)].filter(Boolean).join(' · ');

function PaymentLine({ p, names, national }: { p: PreviewPayment; names: RuleNames; national?: RuleLine[] }) {
  const would = p.would.lines.map((l) => lineText(l, names)).join(' + ');
  return (
    <li>
      <span className="m">{formatDate(p.date)} · {p.currency} {fmt(p.amount)}</span> {p.text}
      {' → '}
      <b>{p.would.kind === 'ask' ? t('rules.preview.ask', { question: p.would.question }) : would}</b>
      <span className="m">{' · '}{p.decidedBy ? t('rules.preview.otherFirst') : p.now.length ? t('rules.preview.now', { booking: p.now.map((l) => lineText(l, names)).join(' + ') }) : t('rules.preview.unbooked')}</span>
      {p.beforeAi && !p.decidedBy ? <span className="m" data-testid="before-ai">{' · '}{t('rules.preview.beforeAi', { booking: p.beforeAi.map((l) => lineText(l, names)).join(' + ') })}</span> : null}
      {national ? <span className="m" data-testid="national">{' · '}{t('rules.preview.national', { booking: national.map((l) => l.vat ?? '–').join(' + ') })}</span> : null}
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
 * is named with its reason and cannot be kept. A draft that holds no rule shows nothing.
 */
export function RuleDraft({ path, nav, onRules, onDone, title }: { path: string; nav?: Nav; onRules?(): void; onDone?(done: Done): void; title?: string }) {
  const [d, setD] = useState<DraftView | null>();
  const [done, setDone] = useState<Done>();
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
        <span>{t(`rules.draft.${done}`)}</span>
        {done !== 'discarded' && onRules ? <button type="button" className="linkbtn" onClick={onRules}>{t('rules.draft.toRules')}</button> : null}
      </div>
    );
  }
  if (!d) return null;
  const names = namesOf(d, money);
  const say = (r: RuleRow) => lineOf(r, names, words);
  const onlyRemoval = !d.added.length && !d.changed.length && d.removed.length > 0;
  const go = async (kind: 'keep' | 'discard') => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.draftCommand(kind === 'keep' ? { kind, path, basis: d.basis, confirm: d.confirm } : { kind, path });
      if (r.ok) { const done = kind === 'discard' ? 'discarded' : onlyRemoval ? 'removedDone' : 'kept'; if (onDone) onDone(done); else setDone(done); }
      else setError('message' in r ? r.message : t('rules.draft.gone'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const business = d.path.startsWith('knowledge/rules/') ? undefined : d.path.split('/').pop()!.replace(/\.yaml$/, '');
  return (
    <div className="ruledraft" data-draft={path}>
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
      {d.refused.map((r) => <span key={`x${r.id}`} className="warnline">{t('rules.draft.refused', { id: r.id || '?', why: refusalText(r) })}</span>)}
      {error ? <span className="warnline">{error}</span> : null}
      <span className="ruleacts">
        {d.keepable ? <button type="button" className="btn primary" disabled={busy} onClick={() => void go('keep')}>{t(onlyRemoval ? 'rules.draft.remove' : d.confirm ? 'rules.draft.keepAnyway' : 'rules.draft.keep')}</button> : null}
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void go('discard')}>{t('rules.draft.discard')}</button>
        {nav && !d.keepable ? <button type="button" className="linkbtn" onClick={() => nav.go({ route: { area: 'changes', commit: 'draft', file: path }, query: {} })}>{t('rules.draft.diff')}</button> : null}
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
      <span>{t('rules.share.ask', { who, percent: String(offer.percent), account: offer.booking.account })}</span>
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
      <span>{t(offer.to.vat !== offer.from.vat ? 'rules.correction.askVat' : 'rules.correction.ask', { who, from: offer.from.account, to: offer.to.account, vat: offer.to.vat ?? t('journal.noVat') })}</span>
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
export function ShareOffers({ refs, onRules }: { refs: string[]; onRules?(): void }) {
  const [offers, setOffers] = useState<ShareOffer[]>([]);
  const key = refs.join(' ');
  useEffect(() => {
    let live = true;
    Promise.all(refs.map((r) => api.shareOffer(r).then((x) => x.offer, () => null))).then((xs) => {
      const one = new Map(xs.filter((o): o is ShareOffer => !!o).map((o) => [`${o.path}#${o.payer}#${o.percent}#${o.booking.account}`, o]));
      if (live) setOffers([...one.values()]);
    });
    return () => { live = false; };
  }, [key]);
  return <>{offers.map((o) => <ShareOfferCard key={o.ref} offer={o} onRules={onRules} />)}</>;
}
