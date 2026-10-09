import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, GitMerge } from 'lucide-react';
import type { Index } from '../../types/index.js';
import type { LogCommit } from '../../books/history.js';
import { api, errorText } from '../lib/api.js';
import { formatDate } from '../lib/utils.js';
import { ChangeView } from './change-view.js';
import { t } from '../i18n/index.js';

/**
 * The Protokoll: every change to the books as git recorded it (src/books/history.ts), newest
 * first, with who, when, why and the records before and after. In an export it is data/log.json.
 */
export function LogTab({ index }: { index: Index }) {
  const [log, setLog] = useState<LogCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => { api.log().then(setLog, (e) => setError(errorText(e))); }, []);

  const toggle = (hash: string) => setOpen((s) => { const n = new Set(s); if (n.has(hash)) n.delete(hash); else n.add(hash); return n; });

  return (
    <div className="flex-1 overflow-auto p-6" data-testid="log-tab">
      <div className="max-w-5xl mx-auto space-y-2">
        <h2 className="text-base font-semibold text-foreground">{t('log.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('log.intro')}</p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {log && log.length === 0 && <p className="text-sm text-muted-foreground">{t('log.empty')}</p>}
        <ul className="divide-y divide-border rounded-lg border border-border bg-background">
          {log?.map((c) => (
            <li key={c.hash} data-commit={c.hash}>
              <button onClick={() => toggle(c.hash)} className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent">
                {open.has(c.hash) ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <span className="text-xs tabular-nums text-muted-foreground w-36 shrink-0">{formatDate(c.at.slice(0, 10))} {c.at.slice(11, 16)}</span>
                <span className="text-xs font-medium text-foreground w-40 shrink-0 truncate">{c.author.name}</span>
                {c.parents.length > 1 && <GitMerge className="h-3.5 w-3.5 shrink-0 text-violet-600" />}
                <span className="text-sm text-foreground flex-1 truncate">{c.message.split('\n')[0]}</span>
                <span className="text-xs text-muted-foreground shrink-0">{t('log.changes', { n: c.changes.length })}</span>
                <span className="font-mono text-xs text-dim shrink-0">{c.hash.slice(0, 8)}</span>
              </button>
              {open.has(c.hash) && (
                <div className="px-10 pb-3 space-y-1">
                  {c.changes.slice(0, 200).map((ch) => <ChangeView key={`${ch.collection}:${ch.key}`} change={ch} index={index} />)}
                  {c.changes.length > 200 && <p className="text-xs text-muted-foreground">{t('log.more', { n: c.changes.length - 200 })}</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
