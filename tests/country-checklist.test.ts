/**
 * docs/country-checklist.md asks the questions every jurisdiction module answers; each module's
 * decisions.yaml answers them under the same ids, so a new country cannot skip one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { APP_ROOT } from '../src/workspace/workspace.js';

interface Answer { answer?: unknown; law?: unknown; where?: unknown; unverified?: unknown; verified?: unknown }

const checklist = readFileSync(join(APP_ROOT, 'docs/country-checklist.md'), 'utf8');
const questions = [...checklist.matchAll(/^### `([a-z]+\.[a-z-]+)`/gm)].map((m) => m[1]);

const modules = readdirSync(join(APP_ROOT, 'modules'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(APP_ROOT, 'modules', d.name, 'module.yaml')))
  .map((d) => d.name)
  .filter((id) => (parse(readFileSync(join(APP_ROOT, 'modules', id, 'module.yaml'), 'utf8')) as { kind?: string }).kind === 'jurisdiction');

test('the checklist asks each question once', () => {
  assert.ok(questions.length > 40, `found only ${questions.length} questions: is the heading format still ### \`group.id\`?`);
  assert.deepEqual(questions.filter((q, i) => questions.indexOf(q) !== i), []);
});

test('there is a jurisdiction module to hold to the checklist', () => {
  assert.ok(modules.includes('ch'));
});

for (const id of modules) {
  const file = join(APP_ROOT, 'modules', id, 'decisions.yaml');

  test(`modules/${id}/decisions.yaml answers every question of the checklist, in its order`, () => {
    assert.ok(existsSync(file), `modules/${id}/decisions.yaml is missing: answer docs/country-checklist.md`);
    const doc = parse(readFileSync(file, 'utf8')) as { module?: string; answers?: Record<string, Answer> };
    assert.equal(doc.module, id);
    assert.deepEqual(Object.keys(doc.answers ?? {}), questions);
  });

  test(`modules/${id}/decisions.yaml: each answer says what, by which law, and where; every path exists`, () => {
    const { answers } = parse(readFileSync(file, 'utf8')) as { answers: Record<string, Answer> };
    const problems: string[] = [];
    for (const [q, a] of Object.entries(answers)) {
      if (typeof a.answer !== 'string' || !a.answer.trim()) problems.push(`${q}: no answer`);
      if (!Array.isArray(a.law) || !a.law.length || !a.law.every((l) => typeof l === 'string' && l.trim())) problems.push(`${q}: law must list the laws or sources, or say none`);
      if (!Array.isArray(a.where) || !a.where.length) problems.push(`${q}: where must list at least one path`);
      else for (const w of a.where) if (typeof w !== 'string' || !existsSync(join(APP_ROOT, w.split('#')[0]))) problems.push(`${q}: ${String(w)} does not exist`);
      if (a.unverified !== undefined && (typeof a.unverified !== 'string' || !a.unverified.trim())) problems.push(`${q}: unverified must say what to confirm`);
      if (a.verified !== undefined && (typeof a.verified !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(a.verified))) problems.push(`${q}: verified must start with the date of the check and name the sources`);
    }
    assert.deepEqual(problems, []);
  });
}
