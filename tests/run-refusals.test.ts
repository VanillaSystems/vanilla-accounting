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
      const entry = locale.messages[`runWhy.${c}` as keyof typeof locale.messages];
      const texts = typeof entry === 'string' ? [entry] : entry ? [entry.one, entry.other] : [];
      assert.ok(texts.length && texts.every((x) => x.trim()), `${code} runWhy.${c}`);
      for (const text of texts) assert.doesNotMatch(text, INNER, `${code} runWhy.${c}`);
    }
  });
}

/** A run stuck on a fault of the app itself (a step handing on more than its description says, an outcome that leads nowhere): her words and a way on, never the step's inner name (#482). */
const APP_FAULTS = ['emitsExtra', 'leadsNowhere'];

for (const { code, locale } of locales) {
  test(`${code}: a run stuck on a fault of the app names no step and says how to go on`, () => {
    for (const c of APP_FAULTS) {
      const text = locale.messages[`runWhy.${c}` as keyof typeof locale.messages] as string;
      assert.doesNotMatch(text, /\{(step|keys|outcome)\}/, `${code} runWhy.${c}`);
      assert.ok(text.includes(locale.messages['automation.resume']), `${code} runWhy.${c} names «${locale.messages['automation.resume']}»`);
    }
  });
}
