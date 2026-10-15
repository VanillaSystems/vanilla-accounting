/**
 * The AI as a sidebar on the right (docs/0.4.0/views.md, "The AI, as a sidebar"): beside the page,
 * not over it, so the page keeps its keys. ⌘J, the bot button in the top bar, or «Mit KI ändern…»
 * on an object open it. What the page shows goes with a message as a chip; @ adds a workflow or a
 * run. It does what the person asks: changes to the books show as cards, each with «Rückgängig»;
 * changes to how the app works wait in Änderungen.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { fmt, formatDate } from '../lib/utils.js';
import { BotIcon } from '../areas/automation/Graph.js';
import { automationNow } from '../automation/store.js';
import { language } from '../i18n/index.js';
import { textIn } from '../../workflows/model.js';
import type { BookChange, ContextRef, MadeChange } from '../../types/assistant.js';
import type { Index } from '../../types/index.js';
import { withoutChanges } from '../../assistant/changes.js';
import type { Route } from './route.js';
import {
  addContext, closeAssistant, newConversation, openConversation, removeContext, sendMessage, showConversations, stopAnswer, undoChange, useAssistant, wroteDraft,
} from '../assistant/store.js';

interface Props { page: ContextRef | undefined; books: Index; onGo(route: Route): void }

/** One change in the person's words: which receipt, payment or booking, and what it is now. */
function describe(c: BookChange, books: Index): string {
  const receipt = (id: string) => { const r = books.receipts.find((x) => x.id === id); return r?.description || r?.filename || id; };
  const payment = (ref: string) => { const x = books.transactions.find((y) => y.ref === ref); return x ? `${formatDate(x.date)} · ${x.currency} ${fmt(x.amount)}` : ref; };
  switch (c.kind) {
    case 'receipt': {
      const v = c.set.vat;
      const what = [
        c.set.date && formatDate(c.set.date),
        c.set.amount != null && `${c.set.currency ?? ''} ${fmt(c.set.amount)}`.trim(),
        v && (v.hasSwissVat ? (v.vatSummary ?? []).map((g) => t('receipts.vatLine', { rate: g.ratePercent, tax: fmt(g.vat) })).join(', ') : t('receipts.noVat')),
        c.set.description && `«${c.set.description}»`,
      ].filter(Boolean).join(' · ');
      return t('assistant.c.receipt', { name: receipt(c.id), what });
    }
    case 'link': return t('assistant.c.link', { name: receipt(c.receipt), payment: payment(c.payment) });
    case 'unlink': return t('assistant.c.unlink', { name: receipt(c.receipt), payment: payment(c.payment) });
    case 'entry': {
      const e = books.journalEntries?.find((x) => x.id === c.id);
      const what = [
        c.set.accountDebit && t('assistant.c.debit', { account: c.set.accountDebit }),
        c.set.accountCredit && t('assistant.c.credit', { account: c.set.accountCredit }),
        c.set.vatCode !== undefined && t('assistant.c.code', { code: c.set.vatCode || '–' }),
        c.set.amount !== undefined && fmt(c.set.amount),
        c.set.date && formatDate(c.set.date),
        c.set.description && `«${c.set.description}»`,
      ].filter(Boolean).join(' · ');
      return t('assistant.c.entry', { name: e?.description || c.id, what });
    }
  }
}

function Changes({ changes, books }: { changes: MadeChange[]; books: Index }) {
  return (
    <ul className="aichanges">
      {changes.map((c) => (
        <li key={c.id} className={c.undone ? 'undone' : ''}>
          <span>{describe(c.change, books)}</span>
          {c.undone ? <small>{t('assistant.undone')}</small> : <button type="button" className="linkbtn" onClick={() => void undoChange(c)}>{t('assistant.undo')}</button>}
        </li>
      ))}
    </ul>
  );
}

/** What @ offers: the workflows, then the latest runs, matching the typed word. */
function mentions(q: string): ContextRef[] {
  const view = automationNow();
  if (!view) return [];
  const lang = language();
  const all: ContextRef[] = [
    ...view.workflows.map((w): ContextRef => ({ kind: 'workflow', id: w.id, label: textIn(w.label, lang) })),
    ...view.runs.slice(0, 20).map((r): ContextRef => ({ kind: 'run', id: r.id, label: t('automation.run', { id: r.id }) })),
  ];
  const w = q.toLowerCase();
  return all.filter((r) => `${r.label} ${r.id}`.toLowerCase().includes(w)).slice(0, 8);
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
  const area = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (s.open) area.current?.focus(); }, [s.open, s.conversation]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [s.turns]);
  if (!s.open) return null;

  const at = /(?:^|\s)@(\S*)$/.exec(text);
  const offered = at ? mentions(at[1]) : [];
  const choose = (r: ContextRef) => { addContext(r); setText(text.replace(/@(\S*)$/, '')); setPick(0); area.current?.focus(); };
  const send = () => { if (!s.sending && text.trim()) { void sendMessage(text, page); setText(''); } };

  return (
    <aside className="aside" aria-label={t('assistant.title')}>
      <header className="aihead">
        <b><BotIcon /> {t('assistant.title')}</b>
        <span className="aiacts">
          <button type="button" className="chip" onClick={() => void showConversations()} aria-pressed={s.listing}>{t('assistant.conversations')}</button>
          <button type="button" className="chip" disabled={s.sending} onClick={newConversation}>{t('assistant.new')}</button>
          <button type="button" className="chip" aria-label={t('assistant.close')} title={`${t('assistant.close')} · ⌘J`} onClick={closeAssistant}>×</button>
        </span>
      </header>

      {s.listing ? (
        <div className="ailist">
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
                  {turn.tools.map((u, j) => <div key={j} className={`aitool${u.denied ? ' denied' : ''}`}>{u.name}{u.detail ? ` · ${u.detail}` : ''}{u.denied ? ` · ${t('assistant.denied')}` : ''}</div>)}
                  {withoutChanges(turn.text) ? <div className="aitext">{withoutChanges(turn.text)}</div> : !turn.done ? <div className="m">{t('assistant.thinking')}</div> : null}
                  {turn.changes?.length ? <Changes changes={turn.changes} books={books} /> : null}
                  {turn.refused ? <div className="warnline">{t('assistant.refused', { why: turn.refused })}</div> : null}
                  {turn.error ? <div className="warnline">{turn.error}</div> : null}
                </div>
              </div>
              {turn.done && wroteDraft(turn) ? <button type="button" className="linkbtn aidraft" onClick={() => onGo({ area: 'changes' })}>{t('assistant.toChanges')}</button> : null}
            </Fragment>
          )))}
          {s.error ? <p className="warnline">{s.error}</p> : null}
          <div ref={end} />
        </div>
      )}

      {!s.listing ? (
        <div className="aicompose">
          <div className="aichips">
            {page && !s.pageOff ? <Chip r={page} onRemove={() => removeContext('page')} /> : null}
            {s.extra.map((r) => <Chip key={r.kind + r.id} r={r} onRemove={() => removeContext(r)} />)}
          </div>
          {offered.length ? (
            <div className="aimention" role="listbox" aria-label={t('assistant.mention')}>
              {offered.map((r, i) => (
                <button key={r.kind + r.id} type="button" role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); choose(r); }}>
                  {r.label}<small>{t(`assistant.kind.${r.kind}` as 'assistant.kind.entry')}</small>
                </button>
              ))}
            </div>
          ) : null}
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
            <span />
            {s.sending
              ? <button type="button" className="btn" onClick={stopAnswer}>{t('assistant.stop')}</button>
              : <button type="button" className="btn primary" disabled={!text.trim()} onClick={send}><BotIcon />{t('assistant.send')}</button>}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
