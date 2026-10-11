/**
 * The "/" menu's jobs: every processes/*.flow.yaml, in the order the quarter runs them
 * (quarter-close.flow.yaml's steps), the quarter itself after them, then the others.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { APP_ROOT } from '../workspace/workspace.js';
import type { ChatSkill } from '../types/chat.js';

export const PROCESSES_DIR = join(APP_ROOT, 'processes');

interface Flow { id: string; name: string; discharge?: string; steps?: Array<{ process?: string }> }

export function chatSkills(dir = PROCESSES_DIR): ChatSkill[] {
  const flows = readdirSync(dir).filter((f) => f.endsWith('.flow.yaml')).sort()
    .map((f) => parse(readFileSync(join(dir, f), 'utf8')) as Flow);
  const quarter = flows.find((f) => f.id === 'quarter-close');
  const order = [...(quarter?.steps ?? []).flatMap((s) => s.process ? [s.process.replace(/\.flow\.yaml$/, '')] : []), ...(quarter ? [quarter.id] : [])];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return flows
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
    .map((f) => ({ id: f.id, name: f.name, line: (f.discharge ?? '').replace(/\s+/g, ' ').trim() }));
}
