/**
 * The page's own reference for the AI sidebar: what the person has open, as a ContextRef the
 * server reads when the message is sent. Derived from the route; nothing is copied.
 */
import type { Route } from '../shell/route.js';
import type { Index } from '../../types/index.js';
import type { ContextRef } from '../../types/assistant.js';
import { automationNow } from '../automation/store.js';
import { language, t } from '../i18n/index.js';
import { textIn } from '../../workflows/model.js';

export function pageContext(route: Route, books: Index): ContextRef | undefined {
  switch (route.area) {
    case 'journal': {
      if (!route.id) return undefined;
      const e = (books.journalEntries ?? []).find((x) => x.id === route.id);
      return { kind: 'entry', id: route.id, label: e?.description ?? route.id };
    }
    case 'bank': {
      if (!route.payment) return undefined;
      const tx = books.transactions.find((x) => x.ref === route.payment);
      return { kind: 'payment', id: route.payment, label: tx?.description ?? route.payment };
    }
    case 'receipts': {
      if (!route.id) return undefined;
      const r = books.receipts.find((x) => x.id === route.id);
      return { kind: 'receipt', id: route.id, label: r?.filename ?? route.id };
    }
    case 'automation': {
      if (route.view === 'run' || (route.view === 'tasks' && route.run)) return { kind: 'run', id: route.run!, label: t('automation.run', { id: route.run! }) };
      if (route.view === 'workflow' && route.workflow) {
        const w = automationNow()?.workflows.find((x) => x.id === route.workflow);
        return { kind: 'workflow', id: route.workflow, label: w ? textIn(w.label, language()) : route.workflow };
      }
      return undefined;
    }
    case 'changes': return route.file ? { kind: 'file', id: route.file, label: route.file.split('/').pop()! } : undefined;
    default: return undefined;
  }
}
