/**
 * Tooltips (src/app/shell/HoverTip.tsx): a control that shows only an icon names itself with
 * `aria-label` (or `data-tip`), which is what its tooltip says; and no element uses the native
 * `title`, which the Mac app does not show reliably.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/** An icon in this codebase: the icon tables (`ICONS.x`, `I.x`, `W.x`), the few icon constants, an `<svg>` or an `…Icon` component. */
const ICON_EXPR = /^(ICONS|I|W)\.\w+$|^(CHEV|PLAY|BARS)$/;
const isIconTag = (tag: string) => tag === 'svg' || /Icon$/.test(tag);
const CONTROL = new Set(['button', 'a', 'summary']);

const tagOf = (n: ts.JsxElement | ts.JsxSelfClosingElement) => (ts.isJsxElement(n) ? n.openingElement : n).tagName.getText();

/** A letter or digit: a control without one shows only icons or signs (×, ◐, −), and HoverTip shows its aria-label. */
const WORDS = /[\p{L}\p{N}]/u;

/** True when every child is an icon or a sign, so nothing on the control reads as a word. */
function iconOnly(n: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  if (ts.isJsxSelfClosingElement(n)) return true;
  return n.children.every((c) => {
    if (ts.isJsxText(c)) return !WORDS.test(c.text);
    if (ts.isJsxExpression(c)) return !c.expression || ICON_EXPR.test(c.expression.getText());
    if (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) return isIconTag(tagOf(c));
    return false;
  });
}

function tooltipFindings(file: string, text = readFileSync(file, 'utf8')): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const at = (node: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = tagOf(node);
      if (/^[a-z]/.test(tag)) {
        const attrs = new Map(open.attributes.properties.filter(ts.isJsxAttribute).map((a) => [a.name.getText(), a]));
        if (attrs.has('title') && tag !== 'iframe') found.push(`${at(open)} <${tag} title>: use data-tip (or aria-label on an icon control)`);
        const role = attrs.get('role')?.initializer;
        const control = CONTROL.has(tag) || (!!role && ts.isStringLiteral(role) && role.text === 'button');
        const hidden = attrs.has('hidden') || attrs.has('aria-hidden');
        if (control && !hidden && !attrs.has('aria-label') && !attrs.has('data-tip') && iconOnly(node)) {
          found.push(`${at(open)} <${tag}> shows only an icon: give it aria-label={t('…')}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test('icon-only controls carry their tooltip text, and nothing uses the native title', () => {
  const dir = 'src/app';
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.tsx')).map((f) => join(dir, f));
  assert.deepEqual(files.flatMap((f) => tooltipFindings(f)), []);
});

test('the check finds an unnamed icon button and a title', () => {
  const findings = tooltipFindings('x.tsx', [
    'const a = <button type="button" onClick={go}>{ICONS.plus}</button>;',
    'const b = <button type="button"><svg viewBox="0 0 1 1" /></button>;',
    'const c = <span title={t("k")}>x</span>;',
    'const d = <button type="button" aria-label={t("k")}>{ICONS.plus}</button>;',
    'const e = <button type="button">{t("k")}</button>;',
    'const f = <button type="submit" hidden />;',
    'const g = <button type="button" onClick={close}>×</button>;',
  ].join('\n'));
  assert.deepEqual(findings.map((f) => f.split(' ')[0]), ['x.tsx:1', 'x.tsx:2', 'x.tsx:3', 'x.tsx:7']);
});
