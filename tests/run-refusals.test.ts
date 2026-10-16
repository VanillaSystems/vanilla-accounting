/**
 * A workflow step that refuses (a period not ended, a filed period, a missing activity code, a
 * year that cannot close) tells the person why in their language: the refusal is a code of
 * src/types/refusal.ts, and every code has words in each dictionary, free of the app's inner
 * names (persona round 6: the run's English «2026-H2 closes with the year …», «company.vat.rates[].activityId»).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { REFUSAL_CODES } from '../src/types/refusal.js';
import type { Locale } from '../src/app/i18n/types.js';

const LOCALES = 'src/app/i18n/locales';
const locales = await Promise.all(readdirSync(LOCALES).filter((f) => f.endsWith('.ts')).map(async (f) =>
  ({ code: f.slice(0, -3), locale: (await import(`../${LOCALES}/${f}`) as { default: Locale }).default })));

const INNER = /closedThrough|activityId|company\.vat|rates\[\]|\.yaml|\.json|step\.yaml|run\.ts/;

for (const { code, locale } of locales) {
  test(`${code}: every refusal code has words, without the app's inner names`, () => {
    for (const c of REFUSAL_CODES) {
      const text = locale.messages[`runWhy.${c}` as keyof typeof locale.messages];
      assert.ok(typeof text === 'string' && text.trim(), `${code} runWhy.${c}`);
      assert.doesNotMatch(text, INNER, `${code} runWhy.${c}`);
    }
  });
}
