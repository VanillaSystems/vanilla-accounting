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
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useColumnNoAi } from '../ai/ColumnNoAi.js';
import { codeLabel } from '../areas/codes/names.js';
import { flushSync } from 'react-dom';
import { language, t, tData } from '../i18n/index.js';
import { fmt, formatDate } from '../lib/utils.js';
import { BotIcon } from '../areas/automation/Graph.js';
import { ICONS } from '../areas/icons.js';
import { search } from '../assistant/attach.js';
import { dictated, dictationLang, carried, fieldAt, follow, recognizer, type DictationError, type Dictated } from '../assistant/dictation.js';
import { Picker, automationCandidates } from '../assistant/Picker.js';
import { Recording } from '../assistant/Recording.js';
import { isBookChange, type ContextRef, type EntrySet, type HeldChanges, type HeldLine, type InvoicingSet, type MadeChange, type Turn } from '../../types/assistant.js';
import { ApiError, apiFetch, errorText } from '../lib/api.js';
import type { Index } from '../../types/index.js';
import { withoutChanges } from '../../assistant/changes.js';
import { markdownBlocks, type Span } from '../assistant/markdown.js';
import type { Location, Route } from './route.js';
import { OpenPeriodCard } from '../assistant/OpenPeriodCard.js';
import { PRESETS } from '../../export/model.js';
import { postDownload } from '../areas/export/state.js';
import { ReportView } from '../areas/reports/custom/ReportView.js';
import { SetupRail, SetupTitle } from '../onboarding/SetupRail.js';
import { answerTyped, openSetupOnFirstStart } from '../onboarding/state.js';
import { SetupConversation } from '../onboarding/SetupConversation.js';
import { TOPIC_HAND } from '../../onboarding/hand.js';
import { isSetupTopic, questionWordsKey, stateWordsKey, topicWordsKey } from '../../onboarding/model.js';
import { describedOr } from '../assistant/stored-change.js';
import { spanOf } from '../../reports/words.js';
import { specData } from '../../reports/spec.js';
import type { ReportResult } from '../../reports/result.js';
import type { SavedWrite } from '../../reports/saved.js';
import { reloadSaved, undoWrite } from '../areas/reports/custom/store.js';
import { builtInTexts } from '../../invoices/texts.js';
import type { InvoiceLanguage, OWN_TEXTS } from '../../invoices/model.js';
import { api } from '../lib/api.js';
import { RuleDraft, ShareOffers } from '../areas/company/RulesSection.js';
import { MailboxCard } from '../areas/company/MailboxCard.js';
import { TerminalCard } from '../assistant/TerminalCard.js';
import { TerminalButton } from '../assistant/TerminalButton.js';
import { handover } from '../../assistant/handover.js';
import { SourceCard } from '../areas/company/SourceCard.js';
import { questionText } from '../questions/Questions.js';
import { dropFiles } from './DropDialog.js';
import { ATTACHMENT_TYPES, showsAsImage, type Attachment } from '../../types/attachment.js';
import {
  attachFiles, removeFile, uploading, type ComposerFile,
  addContext, closeAssistant, hideConversations, newConversation, openConversation, removeContext, sendMessage, settleHeld, showConversations, stopAnswer, undoAll, undoChange, useAssistant, wroteDraft,
} from '../assistant/store.js';

/** `onGoTo`: to a place with its period, for a link to an object of another period than the one shown. */
interface Props { page: ContextRef | undefined; books: Index; onGo(route: Route): void; onGoTo(loc: Location): void }

/** A booking's fields as they read on a card: accounts, VAT code, amount, date, text. */
function entryWhat(set: EntrySet, withText = true): string {
  return [
    set.accountDebit && t('assistant.c.debit', { account: set.accountDebit }),
    set.accountCredit && t('assistant.c.credit', { account: set.accountCredit }),
    set.vatCode !== undefined && t('assistant.c.code', { code: set.vatCode ? codeLabel(set.vatCode) : '–' }),
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
    case 'privatePayment': {
      const r = books.receipts.find((x) => x.id === c.receipt);
      const amount = `${r?.currency ?? ''} ${fmt(c.amount ?? r?.amount ?? 0)}`.trim();
      const text = c.amount !== undefined && r?.amount != null && c.amount < Math.abs(r.amount)
        ? t('assistant.c.privatePart', { name: receipt(c.receipt), amount, what: c.part ?? t('assistant.c.privatePartUnnamed') })
        : t('assistant.c.privatePayment', { name: receipt(c.receipt), amount });
      return { text: c.replace ? `${text} · ${t('assistant.c.privateReplaced', { entry: c.replace })}` : text, go: { area: 'receipts', id: c.receipt } };
    }
    case 'deletePayment': return { text: t('assistant.c.deletePayment', { name: receipt(c.receipt) }), go: { area: 'receipts', id: c.receipt } };
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
    case 'mailbox': return { text: t(note?.mailbox?.existing ? 'assistant.c.mailboxExisting' : 'assistant.c.mailbox', { address: c.address, host: c.host ?? '' }), go: { area: 'company', section: 'sources' } };
    case 'dropMailbox': return { text: t('assistant.c.dropMailbox') };
    case 'source': return { text: t(note?.source?.replaced ? 'assistant.c.sourceReplaced' : 'assistant.c.source', { label: note?.source?.label?.[language()] ?? note?.source?.label?.en ?? c.id }), go: { area: 'company', section: 'sources' } };
    case 'dropSource': return { text: t('assistant.c.dropSource') };
    case 'export': {
      const preset = PRESETS.some((p) => p.id === c.preset) ? t(`export.preset.${c.preset}` as 'export.preset.treuhand') : c.preset;
      if (failed || !note?.file) return { text: [t('assistant.c.exportNot', { preset }), failed].filter(Boolean).join(' · ') };
      return { text: t('assistant.c.export', { preset, file: note.file.name }), href: api.assistantExportUrl(note.file.name) };
    }
    case 'bookAgain': return { text: failed ? `${t('assistant.c.bookAgainNot')} · ${failed}` : t('assistant.c.bookAgain'), go: { area: 'automation', view: 'runs' } };
    case 'report': return { text: failed ? `${t('assistant.report.not')} · ${failed}` : `${c.spec.title} · ${note?.report ? spanOf(note.report) : c.period ?? c.spec.period}` };
    case 'openPeriod': return { text: t('assistant.c.openPeriod') };
    case 'setupTopic': {
      // A topic or a question of an earlier version (`periods`, `start`) is named by one generic sentence (topicWordsKey).
      const go = isSetupTopic(c.topic) ? TOPIC_HAND[c.topic] : null;
      return { text: t('assistant.c.setupTopic', { topic: tData(topicWordsKey(c.topic)), state: tData(stateWordsKey(c.state)) }), ...(go ? { go } : {}) };
    }
    case 'setupAnswer': return { text: t('assistant.c.setupAnswer', { question: tData(questionWordsKey(c.question)) }) };
    default: return { text: t('assistant.c.unknown') };
  }
}

/** `describe`, for a change read from a stored conversation: never throws (src/app/assistant/stored-change.ts). */
const described = (c: MadeChange, books: Index): ReturnType<typeof describe> => describedOr(() => describe(c, books), () => ({ text: t('assistant.c.unknown') }));

function Changes({ changes, books, onGo, onGoTo }: { changes: MadeChange[]; books: Index; onGo(route: Route): void; onGoTo(loc: Location): void }) {
  return (
    <ul className="aichanges">
      {changes.map((c) => {
        if (c.change.kind === 'report' && c.note?.report) return <li key={c.id} className="aireport"><ReportCard result={c.note.report} period={c.change.period} onGo={onGo} /></li>;
        // Where the open period stands: the app's card, drawn from the books as they are now (#342).
        if (c.change.kind === 'openPeriod') return <li key={c.id} className="aimailbox"><OpenPeriodCard books={books} onGo={onGoTo} /></li>;
        const d = described(c, books);
        const mailbox = c.change.kind === 'mailbox' && c.note?.mailbox && !c.undone ? { id: c.note.mailbox.id, address: c.change.address, host: c.change.host } : undefined;
        const source = c.change.kind === 'source' && c.note?.source && !c.undone ? c.note.source.id : undefined;
        return (
          <Fragment key={c.id}>
          <li className={c.undone ? 'undone' : ''}>
            <span>{d.text}</span>
            <span className="aichangeacts">
              {d.href ? <a className="linkbtn" href={d.href} download>{t('assistant.download')}</a> : null}
              {d.go && !c.undone ? <button type="button" className="linkbtn" onClick={() => onGo(d.go!)}>{t('assistant.show')}</button> : null}
              {c.undone ? <small>{t('assistant.undone')}</small> : c.undo ? <button type="button" className="linkbtn" onClick={() => void undoChange(c)}>{t('assistant.undo')}</button> : null}
            </span>
          </li>
          {mailbox ? <li className="aimailbox"><MailboxCard {...mailbox} onSources={() => onGo({ area: 'company', section: 'sources' })} /></li> : null}
          {source ? <li className="aimailbox"><SourceCard id={source} onSources={() => onGo({ area: 'company', section: 'sources' })} /></li> : null}
          </Fragment>
        );
      })}
    </ul>
  );
}

/**
 * A report the AI wrote as a spec, run by the app (src/reports/): its title and period, its first
 * rows and every total, «PDF» and «CSV» of the whole report, «Bericht speichern» into Eigene
 * Berichte with its «Rückgängig».
 */
function ReportCard({ result, period, onGo }: { result: ReportResult; period?: string; onGo(route: Route): void }) {
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<SavedWrite>();
  const [undone, setUndone] = useState(false);
  const save = () => {
    setError('');
    api.saveReport(specData({ ...result.spec, period: period ?? result.spec.period })).then((w) => { setSaved(w); setUndone(false); return reloadSaved(); })
      .catch((e: unknown) => setError(errorText(e)));
  };
  const undo = () => { if (saved) undoWrite(saved).then(() => setUndone(true), (e: unknown) => setError(errorText(e))); };
  const file = (format: 'pdf' | 'csv') => {
    setError('');
    postDownload('/api/reports/file', { spec: specData(result.spec), period: period ?? result.spec.period, format, language: language() }, `report.${format}`)
      .catch((e: unknown) => setError(t('assistant.report.fileFailed', { why: errorText(e) })));
  };
  return (
    <div className="ruledraft aireportcard" data-testid="report-card">
      <b>{result.spec.title}</b>
      <span className="m">{spanOf(result)}</span>
      <ReportView result={result} preview go={(loc) => onGo(loc.route)} />
      <span className="ruleacts">
        <button type="button" className="btn ghost" onClick={() => file('pdf')}>{t('assistant.report.pdf')}</button>
        <button type="button" className="btn ghost" onClick={() => file('csv')}>{t('assistant.report.csv')}</button>
        {!saved || undone ? <button type="button" className="btn primary" data-testid="report-save" onClick={save}>{t('custom.save')}</button> : (
          <>
            <span className="m" data-testid="report-saved">{t('custom.savedCard')}</span>
            <button type="button" className="linkbtn" onClick={() => onGo({ area: 'reports', report: 'custom', saved: saved.slug })}>{t('custom.show')}</button>
            <button type="button" className="linkbtn" onClick={undo}>{t('custom.undo')}</button>
          </>
        )}
      </span>
      {error ? <span className="warnline">{error}</span> : null}
    </div>
  );
}

const HELD_FIELDS = ['accountDebit', 'accountCredit', 'vatCode', 'amount'] as const;
const heldField = (l: HeldLine, k: (typeof HELD_FIELDS)[number]) => (k === 'accountDebit' ? t('assistant.c.debit', { account: l.accountDebit || '–' })
  : k === 'accountCredit' ? t('assistant.c.credit', { account: l.accountCredit || '–' }) : k === 'vatCode' ? t('assistant.c.code', { code: l.vatCode ? codeLabel(l.vatCode) : '–' }) : fmt(l.amount));

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
  const why = held.why.map((w) => (w === 'payments' ? t(different ? 'assistant.held.payments' : 'assistant.held.many', { n: payments })
    : w === 'deletes' ? t('assistant.held.deletes', { n: deleted }) : w === 'terminal' ? t('assistant.held.terminal') : t('assistant.held.rateWithoutReceipt')));
  // The card of the open period changes nothing: it is no change to propose.
  const proposed = held.changes.filter((c) => c.kind !== 'openPeriod');
  const others = proposed.filter((c) => !isBookChange(c)).map((c, i) => described({ id: String(i), change: c }, books).text);
  const settle = (take: boolean) => { setBusy(true); void settleHeld(turn, take).finally(() => setBusy(false)); };
  return (
    <div className={`ruledraft aiheld ${held.status}`} data-testid="held" data-status={held.status}>
      <b>{held.rows.length ? t('assistant.held.title', { n: held.rows.length }) : t('assistant.held.titleOther', { n: proposed.length })}</b>
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

const Spans = ({ line }: { line: Span[] }) => <>{line.map((x, i) => {
  const text = x.bold ? <strong>{x.text}</strong> : x.text;
  return x.href ? <a key={i} href={x.href} target="_blank" rel="noopener noreferrer">{text}</a> : <Fragment key={i}>{text}</Fragment>;
})}</>;

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
    <span className="aichip" data-kind={r.kind} data-tip={r.kind === 'selection' ? t('assistant.selectionTip') : `${t(`assistant.kind.${r.kind}` as 'assistant.kind.entry')} ${r.id}`}>
      {r.label}
      <button type="button" aria-label={t('assistant.removeContext', { label: r.label })} onClick={onRemove}>×</button>
    </span>
  );
}

/** A file the composer carries: its thumbnail or kind, its name, × to take it off; dimmed while it uploads. */
function FileChip({ f }: { f: ComposerFile }) {
  return (
    <span className={`aichip aifile${f.attachment ? '' : ' uploading'}`} data-tip={f.attachment ? f.name : t('assistant.uploading', { name: f.name })} data-testid="attachment-chip">
      {f.preview ? <img src={f.preview} alt="" /> : <span className="aifilekind">{ATTACHMENT_TYPES[f.type]}</span>}
      {f.name}
      <button type="button" aria-label={t('assistant.removeContext', { label: f.name })} onClick={() => removeFile(f.key)}>×</button>
    </span>
  );
}

/**
 * A file a sent message carried: it opens in a new tab; «Als Beleg übernehmen» hands a copy to the
 * drop (src/app/shell/DropDialog.tsx), which takes it into the inbox as a dropped receipt.
 */
function SentFile({ a, conversation }: { a: Attachment; conversation: string | undefined }) {
  const [state, setState] = useState<'idle' | 'busy' | 'handed'>('idle');
  const url = conversation && api.assistantAttachmentUrl(conversation, a.id);
  const asReceipt = async () => {
    if (!url) return;
    setState('busy');
    try {
      const res = await apiFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await dropFiles([new File([await res.blob()], a.name, { type: a.type })]);
      setState('handed');
    } catch { setState('idle'); }
  };
  return (
    <span className="aisent" data-testid="sent-attachment">
      <a className="aichip aifile" href={url || undefined} target="_blank" rel="noreferrer" data-tip={a.name}>
        {url && showsAsImage(a.type) ? <img src={url} alt="" /> : <span className="aifilekind">{ATTACHMENT_TYPES[a.type]}</span>}
        {a.name}
      </a>
      {state === 'handed' ? <small>{t('assistant.asReceiptDone')}</small>
        : <button type="button" className="linkbtn" disabled={!url || state === 'busy'} onClick={() => void asReceipt()}>{t('assistant.asReceipt')}</button>}
    </span>
  );
}

export function Sidebar({ page, books, onGo, onGoTo }: Props) {
  const columnNoAi = useColumnNoAi(() => onGo({ area: 'company', section: 'ai' }));
  const s = useAssistant();
  const [text, setText] = useState('');
  const [pick, setPick] = useState(0);
  const [picking, setPicking] = useState(false);
  const [ear] = useState(() => recognizer());
  const [listening, setListening] = useState<(() => void) | null>(null);
  const [heardError, setHeardError] = useState<DictationError>();
  const [preparing, setPreparing] = useState(false);
  /** When the microphone began recording, once the language is loaded. */
  const [recordingSince, setRecordingSince] = useState(0);
  /** The words of `text` the recognizer may still change, shown as provisional. */
  const [partial, setPartial] = useState<Dictated['partial']>();
  /** The recognizer measures the microphone: the button follows the voice instead of pulsing. */
  const [measured, setMeasured] = useState(false);
  /** The dictation whose words still go into the field; a sent message lets go of it. */
  const dictation = useRef(0);
  const plus = useRef<HTMLButtonElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const mic = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (s.open) area.current?.focus(); }, [s.open, s.conversation]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [s.turns]);
  useLayoutEffect(() => {
    const field = area.current;
    if (!field || !partial) return;
    if (partial.end === text.length) field.scrollTop = field.scrollHeight;
    if (ghost.current) ghost.current.scrollTop = field.scrollTop;
  }, [text, partial]);
  useEffect(() => () => listening?.(), [listening]);
  useEffect(() => { if (!s.open) listening?.(); }, [s.open, listening]);
  useEffect(() => { void openSetupOnFirstStart(); }, []);
  const setup = s.purpose === 'onboarding';
  if (!s.open) return null;

  const at = /(?:^|\s)@(\S*)$/.exec(text);
  const offered = at ? search(automationCandidates(), at[1], 8).map((c) => c.ref) : [];
  const choose = (r: ContextRef) => { addContext(r); setText(text.replace(/@(\S*)$/, '')); setPick(0); area.current?.focus(); };
  const waiting = uploading(s);
  const send = () => {
    if (s.sending || waiting || !text.trim()) return;
    dictation.current++;
    setPartial(undefined);
    listening?.();
    // In the setup, typed words that name one of the open question's answers answer it as a click would: no AI call.
    if (!(setup && !s.files.length && answerTyped(text))) void sendMessage(text, page);
    setText('');
  };
  const listen = () => {
    if (!ear) return;
    if (listening) { listening(); return; }
    let field = fieldAt(text, area.current?.selectionStart ?? text.length, area.current?.selectionEnd ?? text.length);
    const id = ++dictation.current;
    let caret = field.end;
    setHeardError(undefined);
    setRecordingSince(Date.now());
    const stop = ear.start(dictationLang(language()), {
      heard: (heard) => {
        if (id !== dictation.current) return;
        const el = area.current;
        const typed = follow(field, el?.value ?? field.text);
        if (!typed) {
          dictation.current++;
          setPartial(undefined);
          stop();
          return;
        }
        const d = dictated(typed, heard);
        const selection = el && document.activeElement === el ? [el.selectionStart, el.selectionEnd] : undefined;
        field = d.field;
        caret = d.caret;
        // Rendered at once, so a keystroke after it types into these words, not into the field before them.
        flushSync(() => {
          setText(d.field.text);
          setPartial(d.partial.end > d.partial.start ? d.partial : undefined);
        });
        if (el && selection) el.setSelectionRange(carried(typed, d.field, selection[0]), carried(typed, d.field, selection[1]));
      },
      level: (level) => { setMeasured(true); mic.current?.style.setProperty('--level', String(level)); },
      preparing: (loading) => { setPreparing(loading); if (!loading) setRecordingSince(Date.now()); },
      ended: (error) => {
        setListening(null);
        setHeardError(error);
        setPartial(undefined);
        setMeasured(false);
        mic.current?.style.removeProperty('--level');
        area.current?.focus();
        if (id === dictation.current) area.current?.setSelectionRange(caret, caret);
      },
    });
    setListening(() => stop);
  };
  const empty = !text.trim() || waiting;
  const turnView = (turn: Turn, i: number) => (turn.role === 'me' ? (
    <div key={i} className="msg me">
      {turn.text}
      {turn.context.length ? <small>{turn.context.map((r) => r.label).join(' · ')}</small> : null}
      {turn.attachments?.length ? <span className="aisentfiles">{turn.attachments.map((a) => <SentFile key={a.id} a={a} conversation={s.conversation} />)}</span> : null}
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
          {turn.changes?.length ? <Changes changes={turn.changes} books={books} onGo={onGo} onGoTo={onGoTo} /> : null}
          {!turn.held && (turn.changes ?? []).filter((c) => !c.undone && c.undo).length > 1 ? <button type="button" className="linkbtn" data-act="undo-all" onClick={() => void undoAll(i)}>{t('assistant.undoAll', { n: (turn.changes ?? []).filter((c) => !c.undone && c.undo).length })}</button> : null}
          {turn.done && turn.terminal ? <TerminalCard request={turn.terminal} /> : null}
          {turn.done && turn.changes?.length ? <ShareOffers refs={[...new Set(turn.changes.filter((c) => !c.undone && c.payment).map((c) => c.payment!))]} onRules={() => onGo({ area: 'company', section: 'rules' })} /> : null}
          {turn.refused ? <div className="warnline">{t('assistant.refused', { why: errorText(new ApiError({ error: turn.refused, ...turn.refusal })) })}</div> : null}
          {turn.error ? <div className="warnline">{turn.error}</div> : null}
        </div>
      </div>
      {turn.done && wroteDraft(turn) ? (() => {
        const d = draftsOf(turn);
        return (
          <>
            {d.rules.map((path) => <RuleDraft key={path} path={path} reveal onRules={() => onGo({ area: 'company', section: 'rules' })} />)}
            {d.other || !d.rules.length ? <button type="button" className="linkbtn aidraft" onClick={() => onGo({ area: 'changes' })}>{t('assistant.toChanges')}</button> : null}
          </>
        );
      })() : null}
    </Fragment>
  ));

  // In the setup conversation the buttons carry on without an AI: only the words wait for one.
  const noAi = setup && columnNoAi ? { card: columnNoAi.off ? columnNoAi.card : null, placeholder: t(columnNoAi.off ? 'aiOff.talk' : 'aiSetup.talkWaits') } : columnNoAi;
  return (
    <aside className={setup ? 'aside setup' : 'aside'} aria-label={t(setup ? 'onboarding.title' : 'assistant.title')}>
      <header className="aihead">
        {setup ? <SetupTitle /> : <b><BotIcon /> {t('assistant.title')}</b>}
        <span className="aiacts">
          <button
            type="button" className="aiact" aria-pressed={s.listing} data-tip={t(s.listing ? 'assistant.backToConversation' : 'assistant.pastConversations')}
            onClick={() => (s.listing ? hideConversations() : void showConversations())}
          >{ICONS.clock}{t('assistant.conversations')}</button>
          <button type="button" className="aiact" disabled={s.sending} onClick={newConversation}>{ICONS.plus}{t('assistant.new')}</button>
          <button type="button" className="aiact icon" aria-label={t('assistant.close')} data-tip={`${t('assistant.close')} · ⌘J`} onClick={closeAssistant}>×</button>
        </span>
      </header>
      {setup && !s.listing ? <SetupRail onGo={onGo} /> : null}

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
          {noAi?.card}
          {/* Before the first message: where the open period stands, drawn by code, so it is there without an AI too (#342). */}
          {s.turns.length === 0 && !setup ? <OpenPeriodCard books={books} onGo={onGoTo} /> : null}
          {s.turns.length === 0 && !noAi ? <p className="m aiempty">{t('assistant.empty')}</p> : null}
          {setup ? <SetupConversation turns={s.turns} turn={turnView} onGo={onGo} /> : s.turns.map(turnView)}
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
          {picking ? <Picker page={page} pageOn={!s.pageOff} attached={s.extra} books={books} toggle={plus} onClose={() => { setPicking(false); area.current?.focus(); }} onFile={() => { setPicking(false); picker.current?.click(); }} /> : null}
          <input
            ref={picker} type="file" multiple hidden accept={Object.entries(ATTACHMENT_TYPES).flatMap(([type, ext]) => [type, `.${ext}`]).join(',')} data-testid="attach-input"
            onChange={(e) => { attachFiles([...(e.target.files ?? [])]); e.target.value = ''; area.current?.focus(); }}
          />
          <div className={s.sending ? 'aibox busy' : listening && !preparing ? 'aibox recording' : 'aibox'} data-testid="composer">
            <div className="aichips">
              {page && !s.pageOff ? <Chip r={page} onRemove={() => removeContext('page')} /> : null}
              {s.extra.map((r) => <Chip key={r.kind + r.id} r={r} onRemove={() => removeContext(r)} />)}
              {s.files.map((f) => <FileChip key={f.key} f={f} />)}
            </div>
            {s.fileError ? <div className="warnline aifileerror" role="alert">{s.fileError}</div> : null}
            {heardError ? <div className="warnline aifileerror" role="alert">{t(`assistant.dictation.${heardError}`)}</div> : null}
            <div className="aifield">
              <textarea
                ref={area} rows={3} value={text} disabled={!!noAi} placeholder={noAi?.placeholder ?? t(setup ? 'onboarding.placeholder' : 'assistant.placeholder')} aria-label={t('assistant.message')}
                className={partial ? 'dictating' : undefined}
                onScroll={(e) => { if (ghost.current) ghost.current.scrollTop = e.currentTarget.scrollTop; }}
                onChange={(e) => { setText(e.target.value); setPartial(undefined); setPick(0); }}
                onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); attachFiles(files); } }}
                onKeyDown={(e) => {
                  if (offered.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setPick((pick + (e.key === 'ArrowDown' ? 1 : offered.length - 1)) % offered.length); return; }
                  if (offered.length && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); choose(offered[pick]); return; }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                }}
              />
              {partial ? (
                <div className="aighost" ref={ghost} aria-hidden="true">
                  {text.slice(0, partial.start)}<span>{text.slice(partial.start, partial.end)}</span>{text.slice(partial.end)}
                </div>
              ) : null}
            </div>
            <div className="aibar">
              <button
                type="button" className="aiplus" aria-label={t('assistant.mention')} aria-haspopup="dialog" aria-expanded={picking}
                ref={plus} onClick={() => setPicking(!picking)}
              >{ICONS.plus}</button>
              {listening && preparing ? <small className="aiheard" aria-live="polite">{t('assistant.dictation.preparing')}</small> : null}
              {listening && !preparing ? <Recording since={recordingSince} label={t(ear?.online ? 'assistant.dictation.online' : 'assistant.dictation.recording')} /> : null}
              {ear ? (
                <button
                  ref={mic} type="button" className={`aimic${listening ? ' on' : ''}${listening && measured ? ' level' : ''}`} aria-pressed={!!listening} data-testid="dictate"
                  aria-label={t(listening ? 'assistant.dictation.stop' : 'assistant.dictation.start')}
                  onClick={listen}
                >{listening ? ICONS.stop : ICONS.mic}</button>
              ) : null}
              {setup ? null : <TerminalButton request={() => handover(text, s.turns, t('terminal.handover.context'))} />}
              {s.sending
                ? <button type="button" className="aisend" aria-label={t('assistant.stop')} onClick={stopAnswer}>{ICONS.stop}</button>
                : <button type="button" className="aisend" aria-label={t('assistant.send')} aria-disabled={empty || !!noAi} onClick={noAi ? undefined : send}>{ICONS.arrowUp}</button>}
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
