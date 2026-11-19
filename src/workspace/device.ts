/**
 * This computer as the books know it: a random id and its name, kept in the workspace's data/
 * (local to the computer, never in git), made on first use. What runs on one computer only (the
 * automatic reminders, docs/specs/invoicing.md 4.4.7 and decision 7.4) names the computer it runs on
 * by this id in the manifest; every other copy of the books then knows it is not that one.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { Workspace } from './workspace.js';

export interface Device { id: string; name: string }

const file = (ws: Pick<Workspace, 'paths'>) => join(ws.paths.root, 'data', 'device.json');

/** This computer's id and name; made and kept the first time it is asked for. */
export function thisDevice(ws: Pick<Workspace, 'paths'>): Device {
  const path = file(ws);
  try {
    if (existsSync(path)) {
      const d = JSON.parse(readFileSync(path, 'utf8')) as Partial<Device>;
      if (typeof d.id === 'string' && d.id) return { id: d.id, name: typeof d.name === 'string' && d.name ? d.name : d.id };
    }
  } catch { /* an unreadable file: a new id below */ }
  const made: Device = { id: randomBytes(8).toString('hex'), name: hostname().replace(/\.local$/, '') || 'Mac' };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(made, null, 2)}\n`);
  return made;
}
