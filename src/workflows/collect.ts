/**
 * The actions of the workflows collection and collect (ADR 0014): which sources have a feed due,
 * and the pull of one source. A pull's outcome is the step's outcome: ok, or a person's task for a
 * missing password, a changed page or code that reached past its reach. A failure of the host (a
 * network that is down) gets the run stuck, and the next run goes on from the last checkpoint.
 */
import { APP_ROOT } from '../workspace/workspace.js';
import { sources } from '../platform/sources/index.js';
import { feedDue, pull } from '../platform/sources/host.js';
import { feedState, readLedger } from '../platform/sources/ledger.js';
import { whyNotHere } from '../platform/sources/launcher.js';
import type { Action } from './actions.js';

export const COLLECT_ACTIONS: Record<string, Action> = {
  'source.due': {
    outcomes: ['due', 'none'],
    effects: [],
    emits: ['sources'],
    run(_input, _fx, { ws }) {
      const now = new Date();
      const due = sources(ws, APP_ROOT).flatMap((v) => {
        if (v.kind !== 'ready' || whyNotHere(v.decl)) return [];
        const lines = readLedger(ws, v.decl.id);
        return v.decl.feeds.some((f) => feedDue(f, feedState(lines, f.id).last, now)) ? [{ kind: 'source' as const, id: v.decl.id }] : [];
      });
      return { outcome: due.length ? 'due' : 'none', output: { sources: due } };
    },
  },
  'source.pull': {
    outcomes: ['ok', 'login-needed', 'person-needed', 'missing-secret', 'changed', 'over-reach', 'rate-limited', 'mail-app'],
    effects: ['inbox.add', 'records.import', 'collected.append'],
    emits: ['report'],
    async run(input, _fx, { ws, run }) {
      const r = await pull({ ws, appRoot: APP_ROOT, source: String(input.source), run: run?.id ?? 'run', mode: run?.mode === 'live' || !run ? 'live' : 'dry' });
      return { outcome: r.outcome, output: { report: r } };
    },
  },
};
