/**
 * The composer's «+» (src/app/shell/Sidebar.tsx): a search field over what a message can refer to
 * (src/app/assistant/attach.ts). The first list switches the page's own reference on or off and
 * opens a category; a category searches its receipts, bookings, payments or workflows and runs.
 * Arrows move, Enter takes, Escape goes back a level and then closes.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { language, t } from '../i18n/index.js';
import { ICONS } from '../areas/icons.js';
import { automationNow } from '../automation/store.js';
import { textIn } from '../../workflows/model.js';
import { formatDate } from '../lib/utils.js';
import type { Index } from '../../types/index.js';
import type { ContextRef } from '../../types/assistant.js';
import { bookCandidates, pickRows, sameRef, type Candidate, type PickKind, type PickLevel, type PickRow } from './attach.js';
import { addContext, keepPage, removeContext } from './store.js';
import { runContext } from './context.js';

/** The workflows, then the latest runs: what «@» and the picker's «Ablauf oder Lauf» offer. */
export function automationCandidates(): Candidate[] {
  const view = automationNow();
  if (!view) return [];
  const lang = language();
  const of = (ref: ContextRef, detail: string): Candidate => ({ ref, detail, find: `${ref.label} ${ref.id} ${detail}`.toLowerCase() });
  return [
    ...view.workflows.map((w) => of({ kind: 'workflow', id: w.id, label: textIn(w.label, lang) }, w.id)),
    ...view.runs.slice(0, 20).map((r) => {
      const w = view.workflows.find((x) => x.id === r.workflow);
      return of(runContext(r.id), `${w ? textIn(w.label, lang) : r.workflow} · ${formatDate(r.startedAt.slice(0, 10))}`);
    }),
  ];
}

const kindName = (r: ContextRef) => t(`assistant.kind.${r.kind}` as 'assistant.kind.entry');
const categoryName = (k: PickKind) => t(`assistant.pick.${k}` as 'assistant.pick.receipt');

interface Props {
  /** The page's reference, and whether it goes with the next message. */
  page: ContextRef | undefined;
  pageOn: boolean;
  attached: ContextRef[];
  books: Index;
  /** The button that opens and closes it: a click on it is not a click elsewhere. */
  toggle: RefObject<HTMLElement | null>;
  /** Closed by a choice, Escape or a click elsewhere; the composer takes the focus back. */
  onClose(): void;
  /** «Datei anhängen …»: the composer opens the file picker. */
  onFile(): void;
}

export function Picker({ page, pageOn, attached, books, toggle, onClose, onFile }: Props) {
  const [level, setLevel] = useState<PickLevel>('root');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const sources = useMemo<Record<PickKind, Candidate[]>>(() => ({
    receipt: bookCandidates(books, 'receipt'), entry: bookCandidates(books, 'entry'), payment: bookCandidates(books, 'payment'), automation: automationCandidates(),
  }), [books]);
  useEffect(() => { input.current?.focus(); }, [level]);
  useEffect(() => {
    const away = (e: MouseEvent) => { const target = e.target as Node; if (!box.current?.contains(target) && !toggle.current?.contains(target)) onClose(); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [onClose, toggle]);

  const rows = pickRows(level, query, page, sources, categoryName);
  const at = Math.min(active, Math.max(rows.length - 1, 0));
  useEffect(() => { box.current?.querySelector('.aipickrow.active')?.scrollIntoView({ block: 'nearest' }); }, [at, level, query]);
  const open = (l: PickLevel) => { setLevel(l); setQuery(''); setActive(0); };
  const choose = (r: PickRow) => {
    if (r.kind === 'category') { open(r.of); return; }
    if (r.kind === 'page') { if (pageOn) removeContext('page'); else keepPage(); }
    else if (attached.some((x) => sameRef(x, r.c.ref))) removeContext(r.c.ref);
    else addContext(r.c.ref);
    onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    const move = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (move && rows.length) setActive((at + move + rows.length) % rows.length);
    else if (e.key === 'Enter' && rows[at]) choose(rows[at]);
    else if (e.key === 'Escape') { if (level === 'root') onClose(); else open('root'); }
    else if (e.key === 'Backspace' && !query && level !== 'root') open('root');
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="aipick" role="dialog" aria-label={t('assistant.mention')} ref={box} data-testid="picker">
      <div className="aipickhead">
        {level === 'root' ? ICONS.search : <button type="button" className="aipickback" aria-label={t('assistant.pick.back')} onClick={() => open('root')}>{ICONS.left}</button>}
        {level === 'root' ? null : <b>{categoryName(level)}</b>}
        <input
          ref={input} role="combobox" aria-expanded="true" aria-controls="aipicklist" aria-activedescendant={rows.length ? `aipick-${at}` : undefined}
          aria-label={t('assistant.pick.search')} placeholder={level === 'root' ? t('assistant.pick.search') : t(`assistant.pick.find.${level}` as 'assistant.pick.find.receipt')}
          value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKey}
        />
      </div>
      <div id="aipicklist" className="aipicklist" role="listbox" aria-label={t('assistant.mention')}>
        {rows.length === 0 ? <p className="m">{t('assistant.pick.none')}</p> : null}
        {rows.map((r, i) => {
          const on = r.kind === 'page' ? pageOn : r.kind === 'item' && attached.some((x) => sameRef(x, r.c.ref));
          return (
            <div
              key={r.kind === 'item' ? `${r.c.ref.kind}:${r.c.ref.id}` : r.kind === 'category' ? `c:${r.of}` : 'page'}
              id={`aipick-${i}`} role="option" aria-selected={i === at} aria-checked={r.kind === 'category' ? undefined : on}
              className={`aipickrow${i === at ? ' active' : ''}${on ? ' on' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); choose(r); }} onMouseMove={() => { if (i !== at) setActive(i); }}
            >
              <span className="aipickmark">{on ? ICONS.check : null}</span>
              {r.kind === 'page' ? <span className="aipicktx"><b>{t('assistant.pick.page')}</b><small>{r.ref.label}</small></span>
                : r.kind === 'category' ? <span className="aipicktx"><b>{categoryName(r.of)}</b></span>
                  : <span className="aipicktx"><b>{r.c.ref.label}</b><small>{[kindName(r.c.ref), r.c.detail].filter(Boolean).join(' · ')}</small></span>}
              {r.kind === 'category' ? ICONS.right : null}
            </div>
          );
        })}
      </div>
      {level === 'root' ? (
        <button type="button" className="aipickfile" data-testid="attach-file" onMouseDown={(e) => e.preventDefault()} onClick={onFile}>
          {ICONS.upload}<span>{t('assistant.attachFile')}</span>
        </button>
      ) : null}
    </div>
  );
}
