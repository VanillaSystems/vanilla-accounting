/**
 * A folder dropped on the AI sidebar (src/app/assistant/folder-drop.ts): its PDFs and images, from
 * every subfolder, become attachments; the rest is counted, not sent. Each test names the wrong
 * behaviour it catches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { droppedFiles, MAX_FOLDER_FILES } from '../src/app/assistant/folder-drop.js';

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

test('a folder\'s PDFs and images arrive from every subfolder; other files and hidden ones stay behind, counted', async () => {
  const d = await droppedFiles([dir('Belege Q3', [file('a.pdf', 'application/pdf'), file('b.jpg'), file('notes.txt'), file('.DS_Store'), dir('Juli', [file('c.PDF'), file('d.xlsx')])])], []);
  assert.deepEqual(d.files.map((f) => f.name), ['a.pdf', 'b.jpg', 'c.PDF'], 'every batch and every subfolder read');
  assert.deepEqual(d.folders, ['Belege Q3']);
  assert.equal(d.skipped, 2, 'the text file and the spreadsheet, not the hidden file');
});

test('files dropped without a folder go as they are, refusals and all, as before', async () => {
  const plain = [new File(['x'], 'notes.txt')];
  assert.deepEqual(await droppedFiles([file('notes.txt')], plain), { files: plain, folders: [], skipped: 0, over: 0 });
});

test('a huge folder sends at most the first files and says how many more stayed', async () => {
  const many = Array.from({ length: MAX_FOLDER_FILES + 3 }, (_, i) => file(`r${i}.pdf`, 'application/pdf'));
  const d = await droppedFiles([dir('Alles', many)], []);
  assert.equal(d.files.length, MAX_FOLDER_FILES);
  assert.equal(d.over, 3);
});
