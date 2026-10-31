/**
 * npm run titles [-- --force]
 *
 * Gives every receipt read before titles existed its short title for the lists (src/intake/titles.ts):
 * the vendor and what it is. One small model call per 100 receipts. --force names every receipt again.
 */
import 'dotenv/config';
import { moduleActor } from '../books/store.js';
import { noteLines, storePort } from '../intake/pipeline.js';
import { askIfReady } from '../intake/run.js';
import { titlesStep } from '../intake/titles.js';
import { openWorkspace } from '../workspace/workspace.js';

const ws = openWorkspace();
const { notes } = await titlesStep({ force: process.argv.includes('--force') })({ ws, books: storePort(ws, moduleActor('titles')), ask: await askIfReady(), progress: () => {}, log: (l) => console.log(l) });
for (const line of noteLines(notes)) console.error(line);
if (notes.length) process.exit(1);
