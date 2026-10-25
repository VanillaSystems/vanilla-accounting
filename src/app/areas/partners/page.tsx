/**
 * The shape a page of Geschäftspartner and of Wissen shares (docs/0.4.0/knowledge.md "A page is
 * prose first"): the notes, readable and editable in place, then what the app does by itself (the
 * rules that belong to the page, with how often they applied), then the machine details folded away.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { t } from '../../i18n/index.js';
import { api, errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { hrefOf } from '../../shell/history.js';
import type { Note, NoteTarget } from '../../../knowledge/notes.js';
import type { RuleBooking, RuleWords } from '../../../booking/rules.js';
import type { RuleRow } from '../../../booking/rule-book.js';
import type { RulesView } from '../../../saving/rules.js';
import { codeForRate, firmCodes } from '../../../accounting/vat-codes.js';
import { guessBooking, marksAfter, plain, type ChangedNote } from '../../../knowledge/note-rules.js';
import { openAssistant, sendMessage } from '../../assistant/store.js';
import { ruleLines, type RuleLine } from '../company/rules-model.js';
import { RuleDraft } from '../company/RulesSection.js';
import type { Nav } from '../index.js';
import { proseBlocks, sentenceRuns, type Inline } from './model.js';
import { refreshKnowledge } from './data.js';
import './partners.css';

const words = ((key: string, vars: Record<string, string>) => (t as (k: string, v: Record<string, string>) => string)(key, vars)) as RuleWords;
const money = (n: number) => fmt(n).replace(/\.00$/, '');

/** Every rule of the company in plain words, as Firma › Regeln shows them. */
export const linesOf = (view: RulesView): RuleLine[] => ruleLines(view, words, money);

export const CHEV = <svg className="i chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>;

const runs = (parts: Inline[]) => parts.map((p, i) => (p.bold ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>));

/** A rule that carries out a sentence of the prose, and how it reads. */
export interface Mark { row: RuleRow; line: string }

/** The id of a rule's line under «Das macht die App selbst»: a mark scrolls to it. */
const lineId = (row: RuleRow) => `rule-${row.file}-${row.id}`.replace(/[^\w-]/g, '-');

/** «führt die App aus» after the sentence a rule carries out: it leads to the rule's line on the page. */
function MarkSign({ mark }: { mark: Mark }) {
  const go = (e: { preventDefault(): void }) => {
    e.preventDefault();
    const el = document.getElementById(lineId(mark.row));
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  };
  return <a className="kwmark" href={`#${lineId(mark.row)}`} data-tip={t('partners.notes.markTip', { line: mark.line })} data-mark={mark.row.id} onClick={go}>{t('partners.notes.mark')}</a>;
}

/**
 * The notes as they read, sentence by sentence: a sentence a rule switched on carries out gets its
 * mark; with `propose`, any other sentence offers «Als Regel vorschlagen» when pointed at.
 */
export function Prose({ text, marks = [], propose }: { text: string; marks?: readonly Mark[]; propose?(sentence: string): void }) {
  const placed = new Set<string>();
  const sentence = (parts: Inline[], key: number) => {
    const words = plain(parts.map((p) => p.text).join(''));
    const here = marks.filter((m) => !placed.has(m.row.id) && marksAfter(words, m.row.rule!.note!));
    here.forEach((m) => placed.add(m.row.id));
    return (
      <span key={key} className={`kwsent${here.length ? ' marked' : ''}`}>
        {runs(parts)}
        {here.map((m) => <MarkSign key={m.row.id} mark={m} />)}
        {propose && !here.length ? <button type="button" className="kwprop" data-act="propose-rule" onClick={() => propose(words)}>{t('partners.notes.propose')}</button> : null}
        {' '}
      </span>
    );
  };
  const sentences = (parts: Inline[]) => sentenceRuns(parts).map(sentence);
  return (
    <div className="kwprose">
      {proseBlocks(text).map((b, i) => (b.kind === 'h' ? <h4 key={i}>{b.text}</h4>
        : b.kind === 'ul' ? <ul key={i}>{b.items.map((it, j) => <li key={j}>{sentences(it)}</li>)}</ul>
          : <p key={i}>{sentences(b.parts)}</p>))}
    </div>
  );
}

/**
 * «Notizen»: the prose as it reads; «Bearbeiten» opens a plain text field, «Speichern» keeps it at
 * once, with «Rückgängig» in the toast. A text that changed since the page was read is refused.
 */
export function NotesBlock({ note, target, canEdit, nav, empty, title, marks, propose }: { note?: Note; target: NoteTarget; canEdit: boolean; nav: Nav; empty: string; title?: string; marks?: readonly Mark[]; propose?(sentence: string): void }) {
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (draft === undefined) return;
    setBusy(true);
    try {
      const r = await api.saveNote({ kind: 'save', ref: target, text: draft, basis: note?.basis ?? 'none', ...(title ? { title } : {}) });
      setDraft(undefined);
      refreshKnowledge();
      nav.toast(t(r.after === null ? 'partners.notes.removed' : 'partners.notes.saved'), () => {
        api.saveNote({ kind: 'restore', ref: target, text: r.before, now: r.after }).then(() => { refreshKnowledge(); nav.toast(t('partners.notes.undone')); }, (e) => nav.toast(errorText(e)));
      });
    } catch (e) {
      nav.toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (draft !== undefined) {
    return (
      <section className="kwnotes editing">
        <header><h3>{t('partners.notes.title')}</h3></header>
        <textarea value={draft} rows={12} aria-label={t('partners.notes.title')} autoFocus onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setDraft(undefined); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save(); }} />
        <div className="kwnacts">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{t('common.save')}</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => setDraft(undefined)}>{t('common.cancel')}</button>
          <span className="m">{t('partners.notes.hint')}</span>
        </div>
      </section>
    );
  }
  return (
    <section className="kwnotes">
      <header>
        <h3>{t('partners.notes.title')}</h3>
        {canEdit ? <button type="button" className="linkbtn" data-act="edit-notes" onClick={() => setDraft(note?.text ?? '')}>{t('partners.notes.edit')}</button> : null}
      </header>
      {note?.text ? <Prose text={note.text} marks={marks} propose={canEdit ? propose : undefined} /> : <p className="m">{empty}</p>}
      {note?.last ? (
        <p className="m kwby">
          {t('partners.notes.last', { by: note.last.by, date: formatDate(note.last.at.slice(0, 10)) })}
          {' · '}
          <Go className="linkbtn" nav={nav} to={{ route: { area: 'changes', commit: note.last.commit }, query: {} }}>{t('partners.notes.history')}</Go>
        </p>
      ) : null}
    </section>
  );
}

/** «Das macht die App selbst»: the rules of the page the app carries out, each with how often it applied, and «Ausschalten». */
export function SelfBlock({ lines, canEdit, nav, empty, children, changed = [], adjust }: { lines: RuleLine[]; canEdit: boolean; nav: Nav; empty: string; children?: ReactNode; changed?: readonly ChangedNote[]; adjust?(c: ChangedNote): ReactNode }) {
  const [busy, setBusy] = useState(false);
  const acting = lines.filter((l) => l.acts);
  const act = async (l: RuleLine) => {
    setBusy(true);
    try {
      const r = await api.ruleCommand({ kind: l.row.off ? 'on' : 'off', file: l.row.file, step: l.row.step, id: l.row.id });
      if (!r.ok) { nav.toast(r.message); return; }
      refreshKnowledge();
      const undo = r.undo;
      nav.toast(t(l.row.off ? 'rules.done.on' : 'rules.done.off'), undo && (() => {
        api.ruleCommand({ kind: 'restore', ...undo }).then((x) => { if (!x.ok) nav.toast(x.message); refreshKnowledge(); }, (e) => nav.toast(errorText(e)));
      }));
    } catch (e) {
      nav.toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="kwself">
      <header>
        <h3>{t('partners.self.title')}</h3>
        <Go className="linkbtn" nav={nav} to={{ route: { area: 'company', section: 'rules' }, query: {} }}>{t('partners.self.allRules')}</Go>
      </header>
      {acting.length ? (
        <ul>
          {acting.map((l) => (
            <li key={l.key} id={lineId(l.row)} className={l.row.off ? 'off' : ''} data-rule={l.row.id}>
              <b>{l.line}</b>
              <span className="m">
                {l.row.off ? t('rules.isOff') : [
                  l.applied ? t('rules.applied', { n: l.applied, date: formatDate(l.last) }) : l.asked ? '' : t('rules.neverApplied'),
                  l.asked ? t('rules.asked', { n: l.asked }) : '',
                ].filter(Boolean).join(' · ')}
              </span>
              {canEdit ? <button type="button" className="btn ghost" disabled={busy} onClick={() => void act(l)}>{t(l.row.off ? 'rules.switchOn' : 'rules.switchOff')}</button> : null}
              {changed.filter((c) => c.row.id === l.row.id && c.row.file === l.row.file).map((c) => <div key="changed" className="kwchanged">{adjust?.(c)}</div>)}
            </li>
          ))}
        </ul>
      ) : <p className="m">{empty}</p>}
      {children}
    </section>
  );
}

/** «Details für die App», folded and closed by default. */
export function DetailsBlock({ lead, children }: { lead: string; children: ReactNode }) {
  return (
    <details className="kwdetails">
      <summary>{CHEV}<b>{t('partners.details.title')}</b><span className="m">{lead}</span></summary>
      {children}
    </details>
  );
}

/** One heading of a folded block, with its items; nothing when there are none. */
export function DetailGroup({ title, items, quiet }: { title: string; items: ReactNode[]; quiet?: boolean }) {
  if (!items.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className={quiet ? 'app' : ''}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </>
  );
}

/** A link inside a page that the app follows itself and that also opens in a new tab. */
export function Go({ to, nav, children, className }: { to: Parameters<Nav['go']>[0]; nav: Nav; children: ReactNode; className?: string }) {
  return <a className={className} href={hrefOf(to)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); nav.go(to); }}>{children}</a>;
}

/** The booking a rule makes or proposes, as the note form and «Regel anpassen» start from it. */
const bookingOf = (row: RuleRow): RuleBooking | undefined => (row.rule?.then.kind === 'book' ? row.rule.then.booking : row.rule?.then.booking);

/** What a sentence names that a rule can carry out, as the start of the form. */
const guess = (sentence: string, accounts: Readonly<Record<string, string>>) => guessBooking(sentence, accounts, (rate, account) => codeForRate(rate, account, account));

/** Asks the AI sidebar to draft the rule of a sentence (or to adjust one); its card says by code whether it is offered. */
function askAi(text: string, notes: string, name: string) {
  openAssistant();
  void sendMessage(text, { kind: 'file', id: notes, label: name });
}

/**
 * «Als Regel vorschlagen» on a sentence of a partner's notes: the account, VAT code and private share
 * the sentence names (a first guess, changed at will), drafted with the sentence quoted for the card
 * every drafted rule gets; the card's checks decide whether it is offered. «Die KI fragen» hands the
 * sentence to the AI sidebar instead.
 */
export function NoteRulePanel({ partner, name, notes, sentence, view, nav, onClose }: { partner: string; name: string; notes: string; sentence: string; view: RulesView; nav: Nav; onClose(): void }) {
  const start = guess(sentence, view.names.accounts);
  const [account, setAccount] = useState(start.account ?? '');
  const [vat, setVat] = useState(start.vat ?? '');
  const [share, setShare] = useState(start.private ? String(start.private) : '');
  const [path, setPath] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const codes = firmCodes();
  if (path) return <RuleDraft path={path} nav={nav} title={t('partners.noteRule.title')} onDone={() => { refreshKnowledge(); onClose(); }} />;
  const preview = async (e: FormEvent) => {
    e.preventDefault();
    if (!view.names.accounts[account.trim()]) { setError(t('partners.noteRule.missing')); return; }
    const pct = Number(share.replace(',', '.'));
    setBusy(true);
    setError(undefined);
    try {
      setPath((await api.draftNoteRule({ partner, sentence, then: { account: account.trim(), vat: vat || null, ...(share.trim() && pct > 0 ? { private: pct } : {}) } })).path);
    } catch (x) { setError(errorText(x)); } finally { setBusy(false); }
  };
  return (
    <form className="form inline handrule kwnoterule" data-testid="note-rule" onSubmit={preview} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <span className="wide kwquote">{t('partners.noteRule.lead', { sentence })}</span>
      <label>{t('rules.hand.account')}<input className="mono" list="note-rule-accounts" value={account} onChange={(e) => setAccount(e.target.value)} autoFocus /></label>
      <datalist id="note-rule-accounts">{Object.entries(view.names.accounts).map(([n, label]) => <option key={n} value={n}>{label}</option>)}</datalist>
      {codes.length ? (
        <label>{t('rules.hand.vat')}
          <select value={vat} onChange={(e) => setVat(e.target.value)}>
            <option value="">{t('rules.hand.noVat')}</option>
            {codes.map((c) => <option key={c.code} value={c.code}>{c.code}{c.bananaText ? ` · ${c.bananaText}` : ''}</option>)}
          </select>
        </label>
      ) : null}
      <label>{t('partners.noteRule.private')}<input className="mono" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} /></label>
      {error ? <span className="warnline wide">{error}</span> : null}
      <div className="acts">
        <button type="submit" className="btn primary" disabled={busy}>{t('rules.hand.preview')}</button>
        <button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="linkbtn" onClick={() => { askAi(t('partners.noteRule.aiPrompt', { name, sentence }), notes, name); onClose(); }}>{t('partners.noteRule.askAi')}</button>
      </div>
    </form>
  );
}

/**
 * «Notiz geändert: Regel anpassen?» under a rule whose sentence the person changed: the sentence as
 * the rule quotes it and as it reads now; «Regel anpassen» drafts the rule as the new sentence makes
 * it for the card (as it is and as it would be), and nothing changes until «Behalten».
 */
export function ChangedNotePrompt({ c, partner, name, notes, view, nav }: { c: ChangedNote; partner: string; name: string; notes: string; view: RulesView; nav: Nav }) {
  const [path, setPath] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (path) return <RuleDraft path={path} nav={nav} title={t('partners.changed.cardTitle')} onDone={() => { setPath(undefined); refreshKnowledge(); }} />;
  const rule = c.row.rule!;
  const adjust = async () => {
    const now = c.now!;
    const was = bookingOf(c.row);
    const g = guess(now, view.names.accounts);
    const account = g.account ?? was?.account ?? '';
    const share = g.private ?? was?.private;
    setBusy(true);
    setError(undefined);
    try {
      setPath((await api.draftNoteRule({
        partner, sentence: now, replaces: c.row.id,
        then: { account, vat: g.vat ?? was?.vat ?? null, ...(share ? { private: share } : {}), ...(rule.then.kind === 'ask' ? { ask: rule.then.question } : {}) },
      })).path);
    } catch (x) { setError(errorText(x)); } finally { setBusy(false); }
  };
  return (
    <>
      <b>{t('partners.changed.title')}</b>
      <span className="m">{t('partners.changed.was', { sentence: rule.note! })}</span>
      <span className="m">{c.now ? t('partners.changed.now', { sentence: c.now }) : t('partners.changed.gone')}</span>
      {error ? <span className="warnline">{error}</span> : null}
      {c.now ? (
        <span className="ruleacts">
          <button type="button" className="btn" disabled={busy} data-act="adjust-rule" onClick={() => void adjust()}>{t('partners.changed.adjust')}</button>
          <button type="button" className="linkbtn" onClick={() => askAi(t('partners.noteRule.adjustPrompt', { name, rule: c.row.id, sentence: c.now! }), notes, name)}>{t('partners.noteRule.askAi')}</button>
        </span>
      ) : null}
    </>
  );
}
