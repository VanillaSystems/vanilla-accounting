/**
 * The UI's languages (src/app/i18n): every locale has German's keys, plural forms and
 * placeholders, and no component writes user-visible text past the dictionaries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { Locale } from '../src/app/i18n/types.js';

const LOCALES = 'src/app/i18n/locales';
const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const shape = (v: string | { one: string; other: string }) =>
  typeof v === 'string' ? holes(v) : `plural:${holes(v.one)}|${holes(v.other)}`;

const locales = await Promise.all(readdirSync(LOCALES).filter((f) => f.endsWith('.ts')).map(async (f) =>
  ({ code: f.slice(0, -3), locale: (await import(`../${LOCALES}/${f}`) as { default: Locale }).default })));
const de = locales.find((l) => l.code === 'de')!.locale.messages;

test('de, fr, it and en are there', () => {
  assert.deepEqual(locales.map((l) => l.code).sort(), ['de', 'en', 'fr', 'it']);
});

for (const { code, locale } of locales) {
  test(`${code}: every key of de, with its plural form and placeholders, and no other`, () => {
    assert.deepEqual(Object.keys(locale.messages).sort(), Object.keys(de).sort());
    for (const [key, value] of Object.entries(locale.messages)) {
      assert.equal(shape(value), shape(de[key as keyof typeof de]), `${code} ${key}`);
      for (const text of typeof value === 'string' ? [value] : [value.one, value.other]) assert.ok(text.trim(), `${code} ${key} is empty`);
    }
  });
}

/** Text a user reads, written in a component instead of a dictionary: JSX text and the attributes a browser shows. */
function hardcodedTexts(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const words = /[A-Za-zÄÖÜäöü]{2,}/;
  const allowed = /^(PDF|CHF|EUR|USD|MWST|DBIT|CRDT|Vanilla Accounting)$/;
  const found: string[] = [];
  const report = (node: ts.Node, text: string) => {
    const s = text.trim();
    if (words.test(s) && !allowed.test(s)) found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${s}`);
  };
  /** The literal texts an expression can evaluate to: through `a ? b : c`, `a && b`, parentheses and template parts. */
  const leaves = (e: ts.Node): void => {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) report(e, e.text);
    else if (ts.isTemplateExpression(e)) [e.head, ...e.templateSpans.map((s) => s.literal)].forEach((p) => report(e, p.text));
    else if (ts.isConditionalExpression(e)) { leaves(e.whenTrue); leaves(e.whenFalse); }
    else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) leaves(e.right);
    else if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) { leaves(e.left); leaves(e.right); }
    else if (ts.isParenthesizedExpression(e)) leaves(e.expression);
  };
  const shown = (attr: ts.JsxAttribute) => ['title', 'placeholder', 'aria-label', 'alt', 'label'].includes(attr.name.getText());
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) report(node, node.text);
    if (ts.isJsxAttribute(node) && shown(node) && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) report(node, node.initializer.text);
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) leaves(node.initializer.expression);
    }
    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) leaves(node.expression);
    if (ts.isCallExpression(node) && ['alert', 'confirm'].includes(node.expression.getText())
      && node.arguments[0] && (ts.isStringLiteral(node.arguments[0]) || ts.isTemplateExpression(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) {
      report(node, node.arguments[0].getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test('components show no text outside the dictionaries', () => {
  const dir = 'src/app';
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.tsx')).map((f) => join(dir, f));
  assert.deepEqual(files.flatMap(hardcodedTexts), []);
});
