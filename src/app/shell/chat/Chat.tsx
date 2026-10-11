/**
 * The chat composer (⌘J, or "Claude fragen" in ⌘K): a box at the bottom centre, above the dock.
 * Type, or "/" for a bookkeeping job of processes/, attach files with + or by dropping them on it;
 * Enter sends to Claude, Shift+Enter is a new line. The answer streams into the panel above it; the next message continues the
 * conversation until "Neu". Closed, it keeps its draft and conversation (it is only hidden).
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import type { ChatSend, ChatSkill } from '../../../types/chat.js';
import { api, errorText } from '../../lib/api.js';
import { isKey, language, t, tData } from '../../i18n/index.js';
import type { Nav } from '../../areas/index.js';
import { toClaudeSetup, useClaude } from '../claude.js';
import { canSend, chatReducer, initialChat, skillQuery, type Attachment, type ChatState } from './model.js';
import '../../styles/chat.css';

const svg = (d: string) => <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>;
const ICON = {
  plus: svg('M12 5v14M5 12h14'),
  x: svg('M6 6l12 12M18 6 6 18'),
};

const skillName = (s: ChatSkill) => (isKey(`chat.skill.${s.id}`) ? tData(`chat.skill.${s.id}`) : s.name);
const skillLine = (s: ChatSkill) => (isKey(`chat.skill.${s.id}.line`) ? tData(`chat.skill.${s.id}.line`) : s.line);
const nameOf = (skills: ChatSkill[], id: string) => { const k = skills.find((x) => x.id === id); return k ? skillName(k) : id; };

export function Chat({ open, onClose, nav }: { open: boolean; onClose(): void; nav: Nav }) {
  const [s, dispatch] = useReducer(chatReducer, undefined, () => initialChat(crypto.randomUUID()));
  const claude = useClaude();
  const [skills, setSkills] = useState<ChatSkill[]>([]);
  const [at, setAt] = useState(0);
  const [dragging, setDragging] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stopper = useRef<AbortController>();
  const state = useRef(s);
  state.current = s;

  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    if (!skills.length) api.chatSkills().then(setSkills).catch(() => { /* the menu stays empty */ });
  }, [open, skills.length]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [s.turns]);
  useEffect(() => () => { stopper.current?.abort(); }, []);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [s.draft, open]);

  const query = skillQuery(s);
  const words = (query ?? '').toLowerCase();
  const shown = query === undefined ? [] : skills.filter((k) => `${skillName(k)} ${k.id}`.toLowerCase().includes(words));
  const menuAt = Math.min(at, Math.max(0, shown.length - 1));
  const ready = !claude || claude.state === 'ready';
  const phase = s.phase.kind;

  function attach(files: File[]) {
    const { conversation } = state.current;
    const added: Array<Attachment & { file: File }> = files.map((file) => ({ id: crypto.randomUUID(), name: file.name, file }));
    if (!added.length) return;
    dispatch({ type: 'attach', files: added.map(({ id, name }) => ({ id, name })) });
    for (const a of added) {
      api.chatFile(conversation, a.file)
        .then((path) => dispatch({ type: 'stored', id: a.id, path }))
        .catch(() => dispatch({ type: 'storeFailed', id: a.id }));
    }
  }

  async function send() {
    const now = state.current;
    if (!canSend(now) || !ready) return;
    const message: ChatSend = {
      conversation: now.conversation, text: now.draft, files: now.files.flatMap((f) => (f.path ? [f.path] : [])),
      language: language(), ...(now.skill ? { skill: now.skill } : {}), ...(now.session ? { session: now.session } : {}),
    };
    dispatch({ type: 'send' });
    const stop = new AbortController();
    stopper.current = stop;
    try {
      await api.chat(message, (event) => dispatch({ type: 'event', event }), stop.signal);
      dispatch({ type: 'event', event: { type: 'done', isError: false } });
    } catch (e) {
      if (stop.signal.aborted) dispatch({ type: 'stop' });
      else dispatch({ type: 'event', event: { type: 'error', message: errorText(e) } });
    }
    stopper.current = undefined;
    // Claude may have changed the books through the app's commands.
    nav.refresh();
  }

  function choose(skill: ChatSkill | undefined) {
    if (!skill) return;
    dispatch({ type: 'skill', id: skill.id });
    setAt(0);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (query !== undefined) {
      if (e.key === 'ArrowDown' && shown.length) { e.preventDefault(); setAt((menuAt + 1) % shown.length); return; }
      if (e.key === 'ArrowUp' && shown.length) { e.preventDefault(); setAt((menuAt - 1 + shown.length) % shown.length); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && shown.length) { e.preventDefault(); choose(shown[menuAt]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dispatch({ type: 'draft', text: '' }); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); return; }
    if (e.key === 'Backspace' && s.skill && !s.draft && field.current?.selectionStart === 0) dispatch({ type: 'skill', id: undefined });
  }

  /** Esc anywhere in the chat closes it. */
  function onChatKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  }

  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');
  const drag = {
    onDragEnter: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); setDragging(true); },
    onDragOver: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);
      attach([...e.dataTransfer.files]);
    },
  };

  const skill = skills.find((k) => k.id === s.skill);
  return (
    <div className="chat" hidden={!open} data-testid="chat" data-phase={phase} onKeyDown={onChatKeyDown}>
      {s.turns.length > 0 && <Answers s={s} skills={skills} log={log} onNew={() => { dispatch({ type: 'fresh', conversation: crypto.randomUUID() }); field.current?.focus(); }}
        onStop={() => stopper.current?.abort()} onClose={onClose} />}
      <div className={`composer${dragging ? ' drag' : ''}`} {...drag}>
        {shown.length > 0 || (query !== undefined && skills.length > 0) ? (
          <div className="skills" role="listbox" aria-label={t('chat.skills')} data-testid="chat-skills">
            {shown.length === 0 && <div className="none">{t('chat.noSkill')}</div>}
            {shown.map((k, i) => (
              <div key={k.id} role="option" aria-selected={i === menuAt} className={`o${i === menuAt ? ' on' : ''}`}
                onMouseMove={() => i !== menuAt && setAt(i)} onMouseDown={(e) => { e.preventDefault(); choose(k); }}>
                <span className="n">{skillName(k)}</span><span className="l">{skillLine(k)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {(skill || s.files.length > 0) && (
          <div className="chips">
            {skill && (
              <span className="chip job" data-testid="chat-skill">
                <span className="nm">/{skillName(skill)}</span>
                <button type="button" aria-label={t('chat.removeSkill')} onClick={() => dispatch({ type: 'skill', id: undefined })}>{ICON.x}</button>
              </span>
            )}
            {s.files.map((f) => (
              <span key={f.id} className={`chip${f.failed ? ' failed' : f.path ? '' : ' busy'}`} data-testid="chat-file" title={f.failed ? t('chat.fileFailed') : f.name}>
                {!f.path && !f.failed && <span className="spin sm" />}
                <span className="nm">{f.name}</span>
                <button type="button" aria-label={t('chat.removeFile', { name: f.name })} onClick={() => dispatch({ type: 'detach', id: f.id })}>{ICON.x}</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={field}
          rows={2}
          value={s.draft}
          readOnly={phase === 'sending'}
          placeholder={t('chat.placeholder')}
          aria-label={t('chat.open')}
          onChange={(e) => { dispatch({ type: 'draft', text: e.target.value }); setAt(0); }}
          onKeyDown={onKeyDown}
          onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); attach([...e.clipboardData.files]); } }}
        />
        {!ready && (
          <div className="needs" data-testid="chat-needs-claude">
            <span>{t('chat.needsClaude')}</span>
            <button type="button" className="btn primary" onClick={() => { onClose(); toClaudeSetup(nav); }}>{t('claude.setup')}</button>
          </div>
        )}
        <div className="bar">
          <button type="button" className="ib" aria-label={t('chat.attach')} title={t('chat.attach')} disabled={phase === 'sending'} onClick={() => picker.current?.click()}>{ICON.plus}</button>
          <input ref={picker} type="file" multiple hidden onChange={(e) => { attach([...(e.target.files ?? [])]); e.target.value = ''; }} />
          <span className="grow" />
          {phase === 'sending' && <span className="busy" data-testid="chat-busy" role="status" aria-label={t('chat.working')}><span className="spin" /></span>}
        </div>
        {dragging && <div className="dropping" aria-hidden="true">{t('chat.dropHere')}</div>}
      </div>
    </div>
  );
}

function Answers({ s, skills, log, onNew, onStop, onClose }: {
  s: ChatState; skills: ChatSkill[]; log: React.RefObject<HTMLDivElement>; onNew(): void; onStop(): void; onClose(): void;
}) {
  const sending = s.phase.kind === 'sending';
  return (
    <div className="answers" data-testid="chat-answers">
      <div className="head">
        <span className="t">{t('chat.title')}</span>
        <span className="grow" />
        {sending
          ? <button type="button" className="btn ghost" onClick={onStop}>{t('chat.stop')}</button>
          : <button type="button" className="btn ghost" data-testid="chat-new" onClick={onNew}>{t('chat.new')}</button>}
        <button type="button" className="ib" aria-label={t('chat.close')} title={t('chat.close')} onClick={onClose}>{ICON.x}</button>
      </div>
      <div className="log" ref={log}>
        {s.turns.map((turn, i) => turn.role === 'user' ? (
          <div key={i} className="turn me">
            {(turn.skill || turn.files.length > 0) && (
              <div className="chips">
                {turn.skill && <span className="chip job"><span className="nm">/{nameOf(skills, turn.skill)}</span></span>}
                {turn.files.map((f) => <span key={f} className="chip"><span className="nm">{f}</span></span>)}
              </div>
            )}
            {turn.text && <div className="tx">{turn.text}</div>}
          </div>
        ) : (
          <div key={i} className="turn claude" data-testid="chat-answer">
            {turn.tools.map((u, j) => (
              <div key={j} className={`tool${u.denied ? ' denied' : ''}`}><span className="mono">{u.name}</span> {u.detail}{u.denied && <> · {t('chat.denied')}</>}</div>
            ))}
            {turn.text && <div className="tx">{turn.text}</div>}
            {!turn.done && !turn.text && <div className="tool">{t('chat.working')}</div>}
            {turn.error && <div className="err">{turn.error}</div>}
            {turn.done && !turn.text && !turn.error && <div className="tool">{t('chat.stopped')}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
