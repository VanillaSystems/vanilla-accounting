/**
 * The AI as a sidebar on the right (docs/0.4.0/views.md, "The AI, as a sidebar"): beside the page,
 * not over it, so the page keeps its keys. ⌘J, the bot button in the top bar, or «Mit KI ändern…»
 * on an object open it. What the page shows goes with a message as a chip; @ adds a workflow or a
 * run. It does what the person asks: changes to the books, the chart, the invoicing settings and
 * invoice drafts show as cards, each with «Rückgängig» and a link to what it changed; an answer
 * that rebooks the books rather than fixing one booking waits on one card, booking by booking,
 * for «Übernehmen»; an export shows its file to download; changes to how the app works wait in
 * Änderungen.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { fmt, formatDate } from '../lib/utils.js';
import { BotIcon } from '../areas/automation/Graph.js';
import { ICONS } from '../areas/icons.js';
import { search } from '../assistant/attach.js';
import { Picker, automationCandidates } from '../assistant/Picker.js';
import { isBookChange, type ContextRef, type EntrySet, type HeldChanges, type HeldLine, type InvoicingSet, type MadeChange } from '../../types/assistant.js';
import { ApiError, errorText } from '../lib/api.js';
import type { Index } from '../../types/index.js';
import { withoutChanges } from '../../assistant/changes.js';
import { markdownBlocks, type Span } from '../assistant/markdown.js';
import type { Route } from './route.js';
import { PRESETS } from '../../export/model.js';
import { builtInTexts } from '../../invoices/texts.js';
import type { InvoiceLanguage, OWN_TEXTS } from '../../invoices/model.js';
import { api } from '../lib/api.js';
import { RuleDraft, ShareOffers } from '../areas/company/RulesSection.js';
import { questionText } from '../questions/Questions.js';
import {
  addContext, closeAssistant, hideConversations, newConversation, openConversation, removeContext, sendMessage, settleHeld, showConversations, stopAnswer, undoAll, undoChange, useAssistant, wroteDraft,
} from '../assistant/store.js';

interface Props { page: ContextRef | undefined; books: Index; onGo(route: Route): void }

/** A booking's fields as they read on a card: accounts, VAT code, amount, date, text. */
function entryWhat(set: EntrySet, withText = true): string {
  return [
    set.accountDebit && t('assistant.c.debit', { account: set.accountDebit }),
    set.accountCredit && t('assistant.c.credit', { account: set.accountCredit }),
    set.vatCode !== undefined && t('assistant.c.code', { code: set.vatCode || '–' }),
    set.amount !== undefined && fmt(set.amount),
    set.date && formatDate(set.date),
    withText && set.description && `«${set.description}»`,
  ].filter(Boolean).join(' · ');
}

/** The invoicing settings a card names: the payment term, and each text as it was → as it is now (`before`: the undo's, null the app's own), or put back to the app's own. */
function invoicingWhat(set: InvoicingSet, customers: number | undefined, before: InvoicingSet | undefined): string {
  return [
    set.paymentTermsDays !== undefined && t('assistant.c.terms', { n: set.paymentTermsDays }),
    set.paymentTermsDays !== undefined && customers && t('assistant.c.termsCustomers', { n: customers }),
    ...Object.entries(set.texts ?? {}).flatMap(([lang, texts]) => Object.entries(texts ?? {}).map(([k, v]) => {
      const text = t(`assistant.c.text.${k}` as 'assistant.c.text.intro');
      const L = lang as InvoiceLanguage;
      const key = k as (typeof OWN_TEXTS)[number];
      const was = before?.texts?.[L]?.[key] ?? builtInTexts(L)[key];
      if (v === null) return t('assistant.c.textReset', { text, lang: lang.toUpperCase() });
      return was ? t('assistant.c.text', { text, lang: lang.toUpperCase(), before: was, value: v }) : t('assistant.c.textAdded', { text, lang: lang.toUpperCase(), value: v });
    })),
  ].filter(Boolean).join(' · ');
}

/** One change in the person's words: which receipt, payment or booking, and what it is now; where to see it. A deleted booking is read from its undo. */
function describe({ change: c, undo, note }: MadeChange, books: Index): { text: string; go?: Route; href?: string } {
  const receipt = (id: string) => { const r = books.receipts.find((x) => x.id === id); return r?.description || r?.filename || id; };
  const payment = (ref: string) => { const x = books.transactions.find((y) => y.ref === ref); return x ? `${formatDate(x.date)} · ${x.currency} ${fmt(x.amount)}` : ref; };
  const failed = note?.failed && (note.failed === 'noBrowser' ? t('error.noBrowser') : note.failed);
  switch (c.kind) {
    case 'receipt': {
      const v = c.set.vat;
      const what = [
        c.set.date && formatDate(c.set.date),
        c.set.amount != null && `${c.set.currency ?? ''} ${fmt(c.set.amount)}`.trim(),
        v && (v.hasSwissVat ? (v.vatSummary ?? []).map((g) => t('receipts.vatLine', { rate: g.ratePercent, tax: fmt(g.vat) })).join(', ') : t('receipts.noVat')),
        c.set.description && `«${c.set.description}»`,
      ].filter(Boolean).join(' · ');
      return { text: t('assistant.c.receipt', { name: receipt(c.id), what }), go: { area: 'receipts', id: c.id } };
    }
    case 'link': return { text: t('assistant.c.link', { name: receipt(c.receipt), payment: payment(c.payment) }), go: { area: 'receipts', id: c.receipt } };
    case 'unlink': return { text: t('assistant.c.unlink', { name: receipt(c.receipt), payment: payment(c.payment) }), go: { area: 'receipts', id: c.receipt } };
    case 'receiptKind': return { text: t(`assistant.c.kind.${c.as ?? 'none'}` as 'assistant.c.kind.none', { name: receipt(c.id) }), go: { area: 'receipts', id: c.id } };
    case 'entry': {
      const what = [entryWhat(c.set), note?.vatFollowed && t('assistant.c.vatFollowed', note.vatFollowed), note?.noReceipt && t('assistant.c.noReceipt')].filter(Boolean).join(' · ');
      return { text: t('assistant.c.entry', { name: books.journalEntries?.find((x) => x.id === c.id)?.description || c.id, what }), go: { area: 'journal', id: c.id } };
    }
    case 'newEntry': {
      const what = [entryWhat(c.entry, false), note?.vatFollowed && t('assistant.c.vatFollowed', note.vatFollowed), note?.noReceipt && t('assistant.c.noReceipt')].filter(Boolean).join(' · ');
      return { text: t('assistant.c.newEntry', { name: c.entry.description ?? '', what }), ...(undo?.kind === 'deleteEntry' ? { go: { area: 'journal', id: undo.id } as Route } : {}) };
    }
    case 'deleteEntry': {
      const gone = undo?.kind === 'newEntry' ? undo.entry : undefined;
      return { text: t('assistant.c.deleteEntry', { name: gone?.description || c.id, what: gone ? `${fmt(gone.amount)} · ${formatDate(gone.date)}` : '' }) };
    }
    case 'account': return { text: t(c.name === null ? 'assistant.c.accountGone' : 'assistant.c.account', { number: c.number, name: c.name ?? '' }), go: { area: 'company', section: 'accounts' } };
    case 'invoicing': return { text: t('assistant.c.invoicing', { what: invoicingWhat(c.set, note?.customers, undo?.kind === 'invoicing' ? undo.set : undefined) }), go: { area: 'company', section: 'invoice-layout' } };
    case 'invoiceDraft': {
      const net = (c.draft.lines ?? []).reduce((sum, l) => sum + l.quantity * l.price, 0);
      const text = t('assistant.c.invoiceDraft', { customer: note?.draft?.customer ?? c.newCustomer?.name ?? '', n: c.draft.lines?.length ?? 0, net: fmt(net) });
      return { text, ...(note?.draft ? { go: { area: 'invoices', view: 'list', id: `draft-${note.draft.id}` } as Route } : {}) };
    }
    case 'dropInvoiceDraft': return { text: t('assistant.c.dropInvoiceDraft') };
    case 'question': {
      const open = note?.question?.open;
      if (open) return { text: t('assistant.c.questionOpen', { text: questionText(open, books), to: note.question?.to ?? '' }), go: { area: 'automation', view: 'tasks' } };
      const go: Route = c.on.kind === 'payment' ? { area: 'bank', payment: c.on.id } : c.on.kind === 'receipt' ? { area: 'receipts', id: c.on.id } : { area: 'journal', id: c.on.id };
      return { text: note?.question?.answered ? t('assistant.c.questionAnswered', { text: c.text, by: note.question.answered }) : t('assistant.c.question', { to: note?.question?.to ?? c.to ?? '', text: c.text }), go };
    }
    case 'withdrawQuestion': return { text: t('assistant.c.withdrawQuestion') };
    case 'export': {
      const preset = PRESETS.some((p) => p.id === c.preset) ? t(`export.preset.${c.preset}` as 'export.preset.treuhand') : c.preset;
      if (failed || !note?.file) return { text: [t('assistant.c.exportNot', { preset }), failed].filter(Boolean).join(' · ') };
      return { text: t('assistant.c.export', { preset, file: note.file.name }), href: api.assistantExportUrl(note.file.name) };
    }
    case 'bookAgain': return { text: failed ? `${t('assistant.c.bookAgainNot')} · ${failed}` : t('assistant.c.bookAgain'), go: { area: 'automation', view: 'runs' } };
  }
}

function Changes({ changes, books, onGo }: { changes: MadeChange[]; books: Index; onGo(route: Route): void }) {
  return (
    <ul className="aichanges">
      {changes.map((c) => {
        const d = describe(c, books);
        return (
          <li key={c.id} className={c.undone ? 'undone' : ''}>
            <span>{d.text}</span>
            <span className="aichangeacts">
              {d.href ? <a className="linkbtn" href={d.href} download>{t('assistant.download')}</a> : null}
              {d.go && !c.undone ? <button type="button" className="linkbtn" onClick={() => onGo(d.go!)}>{t('assistant.show')}</button> : null}
              {c.undone ? <small>{t('assistant.undone')}</small> : c.undo ? <button type="button" className="linkbtn" onClick={() => void undoChange(c)}>{t('assistant.undo')}</button> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const HELD_FIELDS = ['accountDebit', 'accountCredit', 'vatCode', 'amount'] as const;
const heldField = (l: HeldLine, k: (typeof HELD_FIELDS)[number]) => (k === 'accountDebit' ? t('assistant.c.debit', { account: l.accountDebit || '–' })
  : k === 'accountCredit' ? t('assistant.c.credit', { account: l.accountCredit || '–' }) : k === 'vatCode' ? t('assistant.c.code', { code: l.vatCode || '–' }) : fmt(l.amount));

/** A held booking as it is → as it would be: the fields that change, and its amount when that stays. */
function heldChange(before: HeldLine | undefined, after: HeldLine | undefined): { was: string; now: string; amount?: string } {
  if (!before || !after) {
    const l = (before ?? after)!;
    const all = HELD_FIELDS.map((k) => heldField(l, k)).join(' · ');
    return before ? { was: all, now: t('assistant.held.deleted') } : { was: t('assistant.held.new'), now: all };
  }
  const moved = HELD_FIELDS.filter((k) => (before[k] ?? '') !== (after[k] ?? ''));
  return {
    was: moved.map((k) => heldField(before, k)).join(' · '),
    now: moved.map((k) => heldField(after, k)).join(' · '),
    ...(moved.includes('amount') ? {} : { amount: fmt(after.amount) }),
  };
}

/**
 * The changes the app held for an answer (src/assistant/held.ts): why, each booking as it is → as it
 * would be, the answer's other changes, and one «Übernehmen» or «Verwerfen». Taken, the changes
 * show below as any answer's, each with its «Rückgängig», and «Alle rückgängig» takes them all back.
 */
function HeldCard({ held, turn, standing, books, onGo }: { held: HeldChanges; turn: number; standing: number; books: Index; onGo(route: Route): void }) {
  const [busy, setBusy] = useState(false);
  const payments = new Set(held.rows.filter((r) => r.before).map((r) => r.ref)).size;
  const deleted = held.rows.filter((r) => r.before && !r.after).length;
  const different = new Set(held.rows.filter((r) => r.before).map((r) => `${r.before!.accountDebit}/${r.before!.accountCredit}`)).size > 1;
  const why = held.why.map((w) => (w === 'payments' ? t(different ? 'assistant.held.payments' : 'assistant.held.many', { n: payments }) : w === 'deletes' ? t('assistant.held.deletes', { n: deleted }) : t('assistant.held.rateWithoutReceipt')));
  const others = held.changes.filter((c) => !isBookChange(c)).map((c, i) => describe({ id: String(i), change: c }, books).text);
  const settle = (take: boolean) => { setBusy(true); void settleHeld(turn, take).finally(() => setBusy(false)); };
  return (
    <div className={`ruledraft aiheld ${held.status}`} data-testid="held" data-status={held.status}>
      <b>{t('assistant.held.title', { n: held.rows.length })}</b>
      {held.status === 'held' ? <span className="m">{t('assistant.held.lead')}</span> : null}
      {why.map((w) => <span key={w} className="warnline">{w}</span>)}
      <ul>
        {held.rows.map((r) => (
          <li key={r.entry} data-entry={r.entry}>
            <button type="button" className="linkbtn" disabled={!(held.status === 'taken' ? r.after : r.before)} onClick={() => onGo({ area: 'journal', id: r.entry })}>{formatDate(r.date)} · {r.text}</button>
            {(() => { const c = heldChange(r.before, r.after); return <span><span className="m">{c.was}</span>{' → '}<b>{c.now}</b>{c.amount ? <span className="m"> · {c.amount}</span> : null}</span>; })()}
            {r.noReceipt ? <span className="warnline" data-testid="no-receipt">{t('assistant.c.noReceipt')}</span> : null}
          </li>
        ))}
        {others.map((o) => <li key={o}>{o}</li>)}
      </ul>
      {held.status === 'held' ? (
        <span className="ruleacts">
          <button type="button" className="btn primary" disabled={busy} onClick={() => settle(true)}>{t('assistant.held.take')}</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => settle(false)}>{t('assistant.held.drop')}</button>
        </span>
      ) : held.status === 'taken' ? (
        <span className="ruleacts">
          <span className="m">{t(standing ? 'assistant.held.taken' : 'assistant.held.undone')}</span>
          {standing ? <button type="button" className="linkbtn" onClick={() => void undoAll(turn)}>{t('assistant.held.undoAll')}</button> : null}
        </span>
      ) : <span className="m">{t('assistant.held.dropped')}</span>}
    </div>
  );
}

/** The draft files an answer wrote, relative to the app's folder; the rules files among them get a card of their own. */
function draftsOf(turn: Extract<Parameters<typeof wroteDraft>[0], { role: 'ai' }>): { rules: string[]; other: boolean } {
  const paths = [...new Set(turn.tools.filter((u) => !u.denied && /^(Edit|Write)$/.test(u.name) && u.detail.startsWith('data/draft/')).map((u) => u.detail.slice('data/draft/'.length)))];
  const rules = paths.filter((p) => p.startsWith('knowledge/') && p.endsWith('.yaml'));
  return { rules, other: paths.length > rules.length };
}

const Spans = ({ line }: { line: Span[] }) => <>{line.map((x, i) => (x.bold ? <strong key={i}>{x.text}</strong> : <Fragment key={i}>{x.text}</Fragment>))}</>;

/** An answer's text with its bold, lists and paragraphs (src/app/assistant/markdown.ts), as elements, never as markup. */
function AnswerText({ text }: { text: string }) {
  return (
    <>
      {markdownBlocks(text).map((b, i) => (b.kind === 'p'
        ? <p key={i}>{b.lines.map((l, j) => <Fragment key={j}>{j ? <br /> : null}<Spans line={l} /></Fragment>)}</p>
        : b.kind === 'ul' ? <ul key={i}>{b.items.map((l, j) => <li key={j}><Spans line={l} /></li>)}</ul>
          : <ol key={i}>{b.items.map((l, j) => <li key={j}><Spans line={l} /></li>)}</ol>))}
    </>
  );
}

function Chip({ r, onRemove }: { r: ContextRef; onRemove(): void }) {
  return (
    <span className="aichip" title={`${t(`assistant.kind.${r.kind}` as 'assistant.kind.entry')} ${r.id}`}>
      {r.label}
      <button type="button" aria-label={t('assistant.removeContext', { label: r.label })} onClick={onRemove}>×</button>
    </span>
  );
}

export function Sidebar({ page, books, onGo }: Props) {
  const s = useAssistant();
  const [text, setText] = useState('');
  const [pick, setPick] = useState(0);
  const [picking, setPicking] = useState(false);
  const plus = useRef<HTMLButtonElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (s.open) area.current?.focus(); }, [s.open, s.conversation]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [s.turns]);
  if (!s.open) return null;

  const at = /(?:^|\s)@(\S*)$/.exec(text);
  const offered = at ? search(automationCandidates(), at[1], 8).map((c) => c.ref) : [];
  const choose = (r: ContextRef) => { addContext(r); setText(text.replace(/@(\S*)$/, '')); setPick(0); area.current?.focus(); };
  const send = () => { if (!s.sending && text.trim()) { void sendMessage(text, page); setText(''); } };
  const empty = !text.trim();

  return (
    <aside className="aside" aria-label={t('assistant.title')}>
      <header className="aihead">
        <b><BotIcon /> {t('assistant.title')}</b>
        <span className="aiacts">
          <button
            type="button" className="aiact" aria-pressed={s.listing} title={t(s.listing ? 'assistant.backToConversation' : 'assistant.pastConversations')}
            onClick={() => (s.listing ? hideConversations() : void showConversations())}
          >{ICONS.clock}{t('assistant.conversations')}</button>
          <button type="button" className="aiact" disabled={s.sending} onClick={newConversation}>{ICONS.plus}{t('assistant.new')}</button>
          <button type="button" className="aiact icon" aria-label={t('assistant.close')} title={`${t('assistant.close')} · ⌘J`} onClick={closeAssistant}>×</button>
        </span>
      </header>

      {s.listing ? (
        <div className="ailist">
          <h2>{t('assistant.pastConversations')}</h2>
          {(s.conversations ?? []).length === 0 ? <p className="m">{t('assistant.noConversations')}</p> : null}
          {(s.conversations ?? []).map((c) => (
            <button key={c.id} type="button" className="aiconv" onClick={() => void openConversation(c.id)}>
              <b>{c.title}</b>
              <small>{formatDate(c.at.slice(0, 10))}{c.context.length ? ` · ${c.context.join(', ')}` : ''}</small>
            </button>
          ))}
        </div>
      ) : (
        <div className="aiturns">
          {s.turns.length === 0 ? <p className="m aiempty">{t('assistant.empty')}</p> : null}
          {s.turns.map((turn, i) => (turn.role === 'me' ? (
            <div key={i} className="msg me">
              {turn.text}
              {turn.context.length ? <small>{turn.context.map((r) => r.label).join(' · ')}</small> : null}
            </div>
          ) : (
            <Fragment key={i}>
              <div className="msg ai">
                <BotIcon />
                <div>
                  {turn.tools.length ? (
                    <details className="aitools">
                      <summary>{t('assistant.details')}</summary>
                      {turn.tools.map((u, j) => <div key={j} className={`aitool${u.denied ? ' denied' : ''}`}>{u.name}{u.detail ? ` · ${u.detail}` : ''}{u.denied ? ` · ${t('assistant.denied')}` : ''}</div>)}
                    </details>
                  ) : null}
                  {withoutChanges(turn.text) ? <div className={turn.done ? 'aitext' : 'aitext pending'}><AnswerText text={withoutChanges(turn.text)} /></div> : !turn.done ? <div className="m">{t('assistant.thinking')}</div> : null}
                  {turn.held ? <HeldCard held={turn.held} turn={i} standing={(turn.changes ?? []).filter((c) => !c.undone && c.undo).length} books={books} onGo={onGo} /> : null}
                  {turn.changes?.length ? <Changes changes={turn.changes} books={books} onGo={onGo} /> : null}
                  {turn.done && turn.changes?.length ? <ShareOffers refs={[...new Set(turn.changes.filter((c) => !c.undone && c.payment).map((c) => c.payment!))]} onRules={() => onGo({ area: 'company', section: 'rules' })} /> : null}
                  {turn.refused ? <div className="warnline">{t('assistant.refused', { why: errorText(new ApiError({ error: turn.refused, ...turn.refusal })) })}</div> : null}
                  {turn.error ? <div className="warnline">{turn.error}</div> : null}
                </div>
              </div>
              {turn.done && wroteDraft(turn) ? (() => {
                const d = draftsOf(turn);
                return (
                  <>
                    {d.rules.map((path) => <RuleDraft key={path} path={path} onRules={() => onGo({ area: 'company', section: 'rules' })} />)}
                    {d.other || !d.rules.length ? <button type="button" className="linkbtn aidraft" onClick={() => onGo({ area: 'changes' })}>{t('assistant.toChanges')}</button> : null}
                  </>
                );
              })() : null}
            </Fragment>
          )))}
          {s.error ? <p className="warnline">{s.error}</p> : null}
          <div ref={end} />
        </div>
      )}

      {!s.listing ? (
        <div className="aicompose">
          {offered.length ? (
            <div className="aimention" role="listbox" aria-label={t('assistant.mention')}>
              {offered.map((r, i) => (
                <button key={r.kind + r.id} type="button" role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); choose(r); }}>
                  {r.label}<small>{t(`assistant.kind.${r.kind}` as 'assistant.kind.entry')}</small>
                </button>
              ))}
            </div>
          ) : null}
          {picking ? <Picker page={page} pageOn={!s.pageOff} attached={s.extra} books={books} toggle={plus} onClose={() => { setPicking(false); area.current?.focus(); }} /> : null}
          <div className="aibox">
            <div className="aichips">
              {page && !s.pageOff ? <Chip r={page} onRemove={() => removeContext('page')} /> : null}
              {s.extra.map((r) => <Chip key={r.kind + r.id} r={r} onRemove={() => removeContext(r)} />)}
            </div>
            <textarea
              ref={area} rows={3} value={text} placeholder={t('assistant.placeholder')} aria-label={t('assistant.message')}
              onChange={(e) => { setText(e.target.value); setPick(0); }}
              onKeyDown={(e) => {
                if (offered.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setPick((pick + (e.key === 'ArrowDown' ? 1 : offered.length - 1)) % offered.length); return; }
                if (offered.length && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); choose(offered[pick]); return; }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
            />
            <div className="aibar">
              <button
                type="button" className="aiplus" aria-label={t('assistant.mention')} title={t('assistant.mention')} aria-haspopup="dialog" aria-expanded={picking}
                ref={plus} onClick={() => setPicking(!picking)}
              >{ICONS.plus}</button>
              {s.sending
                ? <button type="button" className="aisend" aria-label={t('assistant.stop')} title={t('assistant.stop')} onClick={stopAnswer}>{ICONS.stop}</button>
                : <button type="button" className="aisend" aria-label={t('assistant.send')} title={t('assistant.send')} aria-disabled={empty} onClick={send}>{ICONS.arrowUp}</button>}
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
