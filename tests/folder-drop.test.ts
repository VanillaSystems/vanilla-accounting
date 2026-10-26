/**
 * A folder dropped on the window (src/app/lib/folder-drop.ts, #188): on the page every file of it
 * and its subfolders goes to the drop window, at most 2000; on the AI sidebar its PDFs and images,
 * at most 50. A limit hit is said with the limit named and the count left out. Each test names the
 * wrong behaviour it catches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_TAKES, PAGE_TAKES, droppedFiles, leftOut, type Dropped, type Take } from '../src/app/lib/folder-drop.js';
import { formatIn } from '../src/app/i18n/core.js';
import de from '../src/app/i18n/locales/de.js';

interface Node { name: string; isFile: boolean; isDirectory: boolean }
const file = (name: string, type = ''): Node => {
  const f = new File(['x'], name, { type });
  return { name, isFile: true, isDirectory: false, file: (ok: (f: File) => void) => ok(f) } as Node;
};
function dir(name: string, entries: Node[]): Node {
  return {
    name, isFile: false, isDirectory: true,
    // Read in batches of two, as browsers hand a big folder in parts.
    createReader: () => { let at = 0; return { readEntries: (ok: (es: Node[]) => void) => { at += 2; ok(entries.slice(at - 2, at)); } }; },
  } as Node;
}
const said = (d: Dropped, take: Take) => leftOut(d, take).map((x) => formatIn({ code: 'de', ...de }, x.key, x.vars));

/** A quarter's folder as the owner keeps it: receipts at the top, statements in a subfolder, Finder's litter beside them. */
const quarter = () => dir('Q3', [
  file('a.pdf', 'application/pdf'), file('b.jpg'), file('.DS_Store'), file('notes.txt'),
  dir('Kontoauszüge', [file('camt053_2026-07.xml', 'application/xml'), file('Auszug Juli.pdf', 'application/pdf'), dir('.git', [file('HEAD')])]),
]);

test('page: every file of the folder and its subfolders goes to the drop window, statements and all; hidden files and folders stay out', async () => {
  const d = await droppedFiles([quarter()], [], PAGE_TAKES);
  assert.deepEqual(d.files.map((f) => f.name), ['a.pdf', 'b.jpg', 'notes.txt', 'camt053_2026-07.xml', 'Auszug Juli.pdf'], 'the drop window sorts and refuses, not the walk');
  assert.deepEqual([d.folders, d.skipped, d.over], [['Q3'], 0, 0]);
  assert.deepEqual(said(d, PAGE_TAKES), [], 'nothing left out, nothing said');
});

test('page: an empty file in a subfolder stays behind and is said; the files around it go (#194)', async () => {
  const empty = { name: 'leer.pdf', isFile: true, isDirectory: false, file: (ok: (f: File) => void) => ok(new File([], 'leer.pdf')) } as Node;
  const d = await droppedFiles([dir('Q3', [file('a.pdf'), dir('Juli', [file('b.pdf'), empty, file('c.pdf')])])], [], PAGE_TAKES);
  assert.deepEqual(d.files.map((f) => f.name), ['a.pdf', 'b.pdf', 'c.pdf']);
  assert.deepEqual(said(d, PAGE_TAKES), ['Q3: 1 leere Datei nicht übernommen.']);
});

test('page: a folder beside loose files brings both; files alone go as the browser gave them', async () => {
  const d = await droppedFiles([file('loose.pdf', 'application/pdf'), dir('Juli', [file('c.pdf')])], [], PAGE_TAKES);
  assert.deepEqual(d.files.map((f) => f.name), ['loose.pdf', 'c.pdf']);
  const plain = [new File(['x'], 'notes.txt')];
  assert.deepEqual(await droppedFiles([file('notes.txt')], plain, PAGE_TAKES), { files: plain, folders: [], skipped: 0, over: 0 });
});

test('page: 370 files pass whole (no chat cap of 50); past 2000 the rest stays behind and the window says so with the limit', async () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => file(`r${i}.pdf`, 'application/pdf'));
  assert.equal((await droppedFiles([dir('Q3', many(370))], [], PAGE_TAKES)).files.length, 370);
  const d = await droppedFiles([dir('Alles', many(PAGE_TAKES.max + 7))], [], PAGE_TAKES);
  assert.deepEqual([d.files.length, d.over], [2000, 7]);
  assert.deepEqual(said(d, PAGE_TAKES), ['Aus Alles kamen 2000 Dateien dazu, 7 weitere nicht: höchstens 2000 pro Ablage. Den Ordner in kleineren Teilen hierher ziehen.']);
});

test('chat: a folder\'s PDFs and images arrive from every subfolder; the rest is counted and said', async () => {
  const d = await droppedFiles([dir('Belege Q3', [file('a.pdf', 'application/pdf'), file('b.jpg'), file('notes.txt'), file('.DS_Store'), dir('Juli', [file('c.PDF'), file('d.xlsx')])])], [], CHAT_TAKES);
  assert.deepEqual(d.files.map((f) => f.name), ['a.pdf', 'b.jpg', 'c.PDF'], 'every batch and every subfolder read');
  assert.equal(d.skipped, 2, 'the text file and the spreadsheet, not the hidden file');
  assert.deepEqual(said(d, CHAT_TAKES), ['Belege Q3: 2 Dateien nicht angehängt, an die KI gehen nur PDFs und Bilder.']);
});

test('chat: a huge folder sends the first 50 and says the limit and how many more stayed', async () => {
  const many = Array.from({ length: CHAT_TAKES.max + 12 }, (_, i) => file(`r${i}.pdf`, 'application/pdf'));
  const d = await droppedFiles([dir('Alles', many)], [], CHAT_TAKES);
  assert.deepEqual([d.files.length, d.over], [50, 12]);
  assert.deepEqual(said(d, CHAT_TAKES), ['Aus Alles gingen 50 Dateien an die KI, 12 weitere nicht: höchstens 50 pro Nachricht.']);
});
