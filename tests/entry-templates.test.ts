/**
 * Named entry templates (#567): kept in master-data/entry-templates.json, one per name, removed and
 * put back under the same id; they write no books.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApi } from './support/api-server.js';
import { booksOnDisk } from './support/workspace.js';

test('a template is kept, replaced by its name, removed and put back, and the books stay as they were', async () => {
  const api = await startApi('tests/fixtures/period-lock-index.json');
  try {
    const books = JSON.stringify(booksOnDisk(api.ws));
    const first = await api.send('POST', '/api/entry-templates', { name: 'Abschreibung', accountDebit: '6800', accountCredit: '1510', amount: 250, description: 'Abschreibung Mobiliar' });
    assert.equal(first.status, 200, String(first.json.error));
    const kept = first.json.template as { id: string };
    const again = await api.send('POST', '/api/entry-templates', { name: ' abschreibung ', accountDebit: '6800', accountCredit: '1510', amount: 300 });
    assert.equal((again.json.template as { id: string }).id, kept.id, 'the same name is the same template');
    assert.equal((again.json.replaced as { amount: number }).amount, 250, 'the one it replaced, for the undo');
    const split = await api.send('POST', '/api/entry-templates', { name: 'Miete', accountDebit: '', accountCredit: '1020', split: { side: 'accountCredit', lines: [{ account: '6000', amount: 1500 }, { account: '6040' }] } });
    assert.equal(split.status, 200, String(split.json.error));
    const file = join(api.ws.paths.masterData, 'entry-templates.json');
    assert.deepEqual((JSON.parse(readFileSync(file, 'utf8')).templates as Array<{ name: string }>).map((x) => x.name), ['abschreibung', 'Miete']);

    const gone = await api.send('DELETE', `/api/entry-templates/${kept.id}`);
    assert.equal(gone.status, 200);
    assert.equal((await api.send('DELETE', `/api/entry-templates/${kept.id}`)).json.code, 'gone');
    const back = await api.send('POST', '/api/entry-templates', gone.json.template);
    assert.equal((back.json.template as { id: string }).id, kept.id, 'the undo keeps it under its id');

    assert.equal((await api.send('POST', '/api/entry-templates', { name: '  ', accountDebit: '6800', accountCredit: '1510' })).json.code, 'templateName');
    assert.equal((await api.send('POST', '/api/entry-templates', { name: 'x', accountDebit: '6800', accountCredit: '1510', split: { side: 'links', lines: [] } })).status, 400);
    assert.equal(JSON.stringify(booksOnDisk(api.ws)), books, 'no template writes the books');
    assert.ok(existsSync(file));
  } finally {
    await api.stop();
  }
});
