/**
 * The status corner at the top right (docs/0.4.0/views.md, "Status, top right"): a spinner while
 * runs run, an amber dot while tasks wait for a person, nothing when all is quiet. A click opens a
 * panel with what runs, what waits and what finished last; a click elsewhere or Esc closes it.
 */
import { BotIcon } from '../areas/automation/Graph.js';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { useAutomation } from '../automation/store.js';
import { corner, fillTask, textIn } from '../../workflows/model.js';
import { language } from '../i18n/index.js';
import type { Route } from './route.js';

export function Corner({ onGo, onAssistant }: { onGo(route: Route): void; onAssistant(): void }) {
  const { view } = useAutomation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  // The AI's button is always there, at the top right as in the mockup; the status beside it only when something runs or waits.
  const ai = <button type="button" className="cornerbtn aibtn" title={`${t('assistant.title')} · ⌘J`} aria-label={t('assistant.title')} onClick={onAssistant}><BotIcon /></button>;
  if (!view) return <div className="corner">{ai}</div>;
  const c = corner(view);
  if (c.kind === 'quiet' && !open) return <div className="corner">{ai}</div>;
  const go = (route: Route) => { setOpen(false); onGo(route); };
  const label = (id: string) => textIn(view.workflows.find((w) => w.id === id)?.label ?? { en: id }, language());
  const running = view.runs.filter((r) => r.status === 'running' || r.status === 'queued');
  return (
    <div className="corner" ref={ref}>
      {ai}
      <button type="button" className={`cornerbtn ${c.kind}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {c.kind === 'running' ? <span className="spin" aria-hidden="true" /> : c.kind === 'needs-you' ? <span className="amber" aria-hidden="true" /> : null}
        {c.kind === 'running' ? t('corner.running', { n: c.count }) : c.kind === 'needs-you' ? t('corner.needsYou', { n: c.count }) : t('corner.nothing')}
      </button>
      {open ? (
        <div className="cornerpanel" role="dialog" aria-label={t('corner.panel')}>
          {running.map((r) => (
            <button key={r.id} type="button" className="cprow" onClick={() => go({ area: 'automation', view: 'run', run: r.id })}>
              <span className="spin small" aria-hidden="true" /><b>{label(r.workflow)}</b><span className="m mono">{r.item.id}</span>
            </button>
          ))}
          {view.tasks.map((task) => (
            <button key={task.run} type="button" className="cprow" onClick={() => go({ area: 'automation', view: 'tasks', run: task.run })}>
              <span className="amber" aria-hidden="true" /><b>{fillTask(textIn(task.title, language()), task.item)}</b>
            </button>
          ))}
          {!running.length && !view.tasks.length ? <p className="m">{t('corner.nothing')}</p> : null}
          <span className="cplinks">
            <button type="button" className="linkbtn" onClick={() => go({ area: 'automation', view: 'queue' })}>{t('corner.toQueue')}</button>
            <button type="button" className="linkbtn" onClick={() => go({ area: 'automation', view: 'tasks' })}>{t('corner.toTasks')}</button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
