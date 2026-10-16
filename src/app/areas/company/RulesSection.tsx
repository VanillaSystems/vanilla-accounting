/**
 * Firma › Regeln: every rule of the company in plain words, where it came from and how often it
 * applied, with «Ausschalten» and «Löschen» (each with an undo in the toast). RuleDraft is the card
 * of a rule the AI drafted: the sidebar and Änderungen show it, «Behalten» saves it at once.
 */
import { useEffect, useState } from 'react';
import { t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import type { RuleRow } from '../../../booking/rule-book.js';
import type { RuleNames, RuleWords } from '../../../booking/rules.js';
import type { RuleLine } from '../../../booking/classify.js';
import type { PreviewPayment, RulePreview } from '../../../booking/rule-preview.js';
import type { DraftView, RulesView } from '../../../saving/rules.js';
import type { ShareOffer } from '../../../saving/share-rule.js';
import type { Nav } from '../index.js';
import { lineOf, namesOf, refusalKey, ruleLines } from './rules-model.js';

const words = ((key: string, vars: Record<string, string>) => (t as (k: string, v: Record<string, string>) => string)(key, vars)) as RuleWords;
const money = (n: number) => fmt(n).replace(/\.00$/, '');

function origin(r: RuleRow): string {
  if (r.origin === 'other') return r.source ? t('rules.from.other', { source: r.source }) : t('rules.from.unknown');
  return t(`rules.from.${r.origin}`);
}

const refusalText = (r: RuleRow) => (r.kind === 'note' ? t('rules.refuse.prose') : r.refusal ? (() => { const k = refusalKey(r.refusal); return t(k.key, k.vars as never); })() : '');

export function RulesSection({ nav, canEdit }: { nav: Nav; canEdit: boolean }) {
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
              {canEdit && row.kind === 'rule' ? <button type="button" className="btn ghost" disabled={busy} onClick={() => void act(row, row.off ? 'on' : 'off')}>{t(row.off ? 'rules.switchOn' : 'rules.switchOff')}</button> : null}
              {canEdit ? <button type="button" className="btn ghost" disabled={busy} onClick={() => void act(row, 'delete')}>{t('rules.delete')}</button> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Done = 'kept' | 'removedDone' | 'discarded';

/** A booking line as the card names it: account and name, VAT code, amount. */
const lineText = (l: RuleLine, names: RuleNames) => [names.account(l.account) ? `${l.account} ${names.account(l.account)}` : l.account, l.vat, fmt(l.amount)].filter(Boolean).join(' · ');

function PaymentLine({ p, names }: { p: PreviewPayment; names: RuleNames }) {
  const would = p.would.lines.map((l) => lineText(l, names)).join(' + ');
  return (
    <li>
      <span className="m">{formatDate(p.date)} · {p.currency} {fmt(p.amount)}</span> {p.text}
      {' → '}
      <b>{p.would.kind === 'ask' ? t('rules.preview.ask', { question: p.would.question }) : would}</b>
      <span className="m">{' · '}{p.decidedBy ? t('rules.preview.otherFirst') : p.now.length ? t('rules.preview.now', { booking: p.now.map((l) => lineText(l, names)).join(' + ') }) : t('rules.preview.unbooked')}</span>
    </li>
  );
}

/** What one drafted rule would do on this year's payments, and the rules it meets there. */
function Preview({ p, names }: { p: RulePreview; names: RuleNames }) {
  return (
    <div className="rulepreview" data-preview={p.key}>
      <span className="m">{p.matches ? t('rules.preview.matches', { n: p.matches, year: p.year }) : t('rules.preview.none', { year: p.year })}</span>
      {p.examples.length ? <ul>{p.examples.map((x) => <PaymentLine key={x.ref} p={x} names={names} />)}</ul> : null}
      {p.matches > p.examples.length ? <span className="m">{t('rules.preview.more', { n: p.matches - p.examples.length })}</span> : null}
      {p.overlaps.map((o) => (
        <span key={`${o.row.file}#${o.row.step}#${o.row.id}`} className="warnline">
          {t('rules.preview.overlap', { n: o.shared, line: lineOf(o.row, names, words) })}
          {o.theirs ? ` ${t('rules.preview.theirs', { n: o.theirs })}` : ''}
        </span>
      ))}
      {p.loneWords.length ? <span className="warnline">{t('rules.preview.wide', { words: p.loneWords.map((w) => `«${w}»`).join(', ') })}</span> : null}
    </div>
  );
}

/**
 * The card of one drafted rules file: each added, changed or removed rule in one plain line, then
 * «Behalten» (or «Ja, entfernen» for a removal) and «Verwerfen». A rule the app cannot carry out
 * is named with its reason and cannot be kept. A draft that holds no rule shows nothing.
 */
export function RuleDraft({ path, nav, onRules }: { path: string; nav?: Nav; onRules?(): void }) {
  const [d, setD] = useState<DraftView | null>();
  const [done, setDone] = useState<Done>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { api.draftRules(path).then(setD, () => setD(null)); }, [path]);
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
      if (r.ok) setDone(kind === 'discard' ? 'discarded' : onlyRemoval ? 'removedDone' : 'kept');
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
      <span className="m">{t('rules.draft.title')}</span>
      <ul>
        {d.added.map((r) => <li key={`a${r.step}${r.id}`}><span className="rk">{t('rules.draft.added')}</span> <b>{say(r)}</b></li>)}
        {d.changed.map((r, i) => (
          <li key={`c${r.step}${r.id}`}>
            <span className="rk">{t('rules.draft.changed')}</span> {t('rules.draft.was', { line: say(d.before[i]) })}
            <br /><span className="rk">{t('rules.draft.becomes')}</span> <b>{say(r)}</b>
          </li>
        ))}
        {d.removed.map((r) => (
          <li key={`r${r.step}${r.id}`}>
            <span className="rk">{t('rules.draft.removed')}</span> <b>{say(r)}</b>
            {d.held[r.id] ? <span className="m"> {t('rules.draft.held', { n: d.held[r.id] })}</span> : null}
          </li>
        ))}
      </ul>
      {d.preview.map((p) => <Preview key={p.key} p={p} names={names} />)}
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

/** One «Immer so?»: the split as a rule, drafted on the click and then shown on its card. */
function ShareOfferCard({ offer, onRules }: { offer: ShareOffer; onRules?(): void }) {
  const [path, setPath] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (path) return <RuleDraft path={path} onRules={onRules} />;
  const who = offer.business?.name ?? t('rules.share.payer', { payer: offer.payer ?? '' });
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
