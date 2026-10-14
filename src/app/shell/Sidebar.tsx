/**
 * The AI as a sidebar on the right (docs/0.4.0/views.md, "The AI, as a sidebar"): beside the page,
 * not over it, so the page keeps its keys. ⌘J, the bot button in the top bar, or «Mit KI ändern…»
 * on an object open it. What the page shows goes with a message as a chip; @ adds a workflow or a
 * run. Fragen only reads; Ändern writes into the draft, which waits in Änderungen.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { formatDate } from '../lib/utils.js';
import { BotIcon } from '../areas/automation/Graph.js';
import { automationNow } from '../automation/store.js';
import { language } from '../i18n/index.js';
import { textIn } from '../../workflows/model.js';
import type { ContextRef } from '../../types/assistant.js';
import type { Route } from './route.js';
import {
  addContext, closeAssistant, newConversation, openConversation, removeContext, sendMessage, setMode, showConversations, stopAnswer, useAssistant, wroteDraft,
} from '../assistant/store.js';

interface Props { page: ContextRef | undefined; onGo(route: Route): void }

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

export function Sidebar({ page, onGo }: Props) {
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
          {s.turns.length === 0 ? <p className="m aiempty">{s.mode === 'ask' ? t('assistant.emptyAsk') : t('assistant.emptyChange')}</p> : null}
          {s.turns.map((turn, i) => (turn.role === 'me' ? (
            <div key={i} className="msg me">
              {turn.text}
              {turn.context.length ? <small>{turn.context.map((r) => r.label).join(' · ')}{turn.mode === 'change' ? ` · ${t('assistant.change')}` : ''}</small> : null}
            </div>
          ) : (
            <Fragment key={i}>
              <div className="msg ai">
                <BotIcon />
                <div>
                  {turn.tools.map((u, j) => <div key={j} className={`aitool${u.denied ? ' denied' : ''}`}>{u.name}{u.detail ? ` · ${u.detail}` : ''}{u.denied ? ` · ${t('assistant.denied')}` : ''}</div>)}
                  {turn.text ? <div className="aitext">{turn.text}</div> : !turn.done ? <div className="m">{t('assistant.thinking')}</div> : null}
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
            ref={area} rows={3} value={text} placeholder={s.mode === 'ask' ? t('assistant.placeholderAsk') : t('assistant.placeholderChange')} aria-label={t('assistant.message')}
            onChange={(e) => { setText(e.target.value); setPick(0); }}
            onKeyDown={(e) => {
              if (offered.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setPick((pick + (e.key === 'ArrowDown' ? 1 : offered.length - 1)) % offered.length); return; }
              if (offered.length && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); choose(offered[pick]); return; }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
          />
          <div className="aibar">
            <span className="aimode" role="radiogroup" aria-label={t('assistant.mode')}>
              {(['ask', 'change'] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={s.mode === m} className={s.mode === m ? 'on' : ''} title={t(`assistant.${m}Tip` as 'assistant.askTip')} onClick={() => setMode(m)}>{t(`assistant.${m}` as 'assistant.ask')}</button>
              ))}
            </span>
            {s.sending
              ? <button type="button" className="btn" onClick={stopAnswer}>{t('assistant.stop')}</button>
              : <button type="button" className="btn primary" disabled={!text.trim()} onClick={send}><BotIcon />{t('assistant.send')}</button>}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
