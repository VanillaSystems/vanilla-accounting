/**
 * Every button whose click or submit waits shows it (owner rule 2026-11-15, AGENTS.md «UI texts»):
 * it is an `AsyncButton` (a form's: inside an `AsyncForm`, src/app/shell/AsyncButton.tsx), which
 * shows a spinner after 150 ms, keeps its width, sets aria-busy and refuses a second click while
 * the promise its handler returns is pending.
 *
 * The check reads src/app with the type checker. A handler waits when it is async, returns a
 * promise, or calls (itself or through up to two functions of src/app) something that returns one,
 * awaited, `void`ed or floating. Refused: such a handler on a plain element (`<button onClick>`, a
 * clickable `<a>` or `<div>`), a `<form>` whose onSubmit waits, a plain submit `<button>` of such a
 * form, and an AsyncButton or AsyncForm whose waiting handler does not return its promise (the
 * button could not tell when it ends; return it, or pass `busy`).
 *
 * Escape hatch: `data-busy-exempt="<why>"` on the element, for a click nobody waits for (navigation,
 * opening a dialog; the check follows callees and may see a wait that is not this click's). Say why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const DIR = 'src/app';
const files = readdirSync(DIR, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f)).map((f) => resolve(join(DIR, f)));
const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX, strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true,
  resolveJsonModule: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
});
const checker = program.getTypeChecker();
const appRoot = resolve(DIR);

/** A promise or anything with a `then` (any and unknown are not). */
const isPromise = (type: ts.Type): boolean =>
  type.isUnion() ? type.types.some(isPromise) : !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) && !!type.getProperty('then');

/** The function a handler expression names, when it is one of src/app: `save`, `props.onKeep` stay unresolved past the app. */
function declarationOf(e: ts.Expression): ts.SignatureDeclaration | undefined {
  let symbol = checker.getSymbolAtLocation(ts.isCallExpression(e) ? e.expression : e);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const d = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!d || !d.getSourceFile().fileName.startsWith(appRoot)) return undefined;
  if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) return d;
  if (ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return d.initializer;
  return undefined;
}

/** Whether a function waits: async, returns a promise, or calls (outside the callbacks it hands on) something that does. */
function waits(fn: ts.SignatureDeclaration, depth: number, seen: Set<ts.Node>): boolean {
  if (seen.has(fn)) return false;
  seen.add(fn);
  if (ts.getCombinedModifierFlags(fn as ts.Declaration) & ts.ModifierFlags.Async) return true;
  const signature = checker.getSignatureFromDeclaration(fn);
  if (signature && isPromise(checker.getReturnTypeOfSignature(signature))) return true;
  const body = (fn as ts.FunctionLikeDeclarationBase).body;
  if (!body) return false;
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (n !== body && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n))) return;
    if (ts.isCallExpression(n)) {
      if (isPromise(checker.getTypeAtLocation(n))) { found = true; return; }
      const callee = depth > 0 ? declarationOf(n) : undefined;
      if (callee && waits(callee, depth - 1, seen)) { found = true; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

function handlerWaits(e: ts.Expression): boolean {
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return waits(e, 2, new Set());
  const d = declarationOf(e);
  if (d) return waits(d, 2, new Set());
  const t = checker.getTypeAtLocation(e);
  return t.getCallSignatures().some((s) => isPromise(s.getReturnType()));
}

const attr = (el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined =>
  el.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
const exprOf = (a: ts.JsxAttribute | undefined): ts.Expression | undefined =>
  a?.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
const intrinsic = (el: ts.JsxOpeningLikeElement) => /^[a-z]/.test(el.tagName.getText());

/** Whether a handler hands its promise back, so AsyncButton and AsyncForm can wait for it. */
function returnsPromise(e: ts.Expression): boolean {
  return checker.getTypeAtLocation(e).getCallSignatures().some((s) => isPromise(s.getReturnType()));
}

function unmarked(file: ts.SourceFile): string[] {
  const found: string[] = [];
  const at = (n: ts.Node, what: string) => found.push(`${file.fileName.slice(appRoot.length - DIR.length)}:${file.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${what}`);
  const visit = (n: ts.Node, waitingForm: boolean) => {
    if (ts.isJsxElement(n) && ['form', 'AsyncForm'].includes(n.openingElement.tagName.getText())) {
      const el = n.openingElement;
      const submit = exprOf(attr(el, 'onSubmit'));
      const w = !!submit && !attr(el, 'data-busy-exempt') && handlerWaits(submit);
      if (w && el.tagName.getText() === 'form') at(el, '<form onSubmit> waits: use AsyncForm');
      if (w && el.tagName.getText() === 'AsyncForm' && !returnsPromise(submit)) at(el, '<AsyncForm onSubmit> waits but returns no promise: return it');
      ts.forEachChild(n, (c) => visit(c, w));
      return;
    }
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && !attr(n, 'data-busy-exempt')) {
      const tag = n.tagName.getText();
      const click = exprOf(attr(n, 'onClick'));
      if (tag === 'AsyncButton') {
        if (click && !attr(n, 'busy') && handlerWaits(click) && !returnsPromise(click)) at(n, '<AsyncButton onClick> waits but returns no promise: return it, or pass busy');
      } else if (intrinsic(n)) {
        if (click && handlerWaits(click)) at(n, `<${tag} onClick> waits: use AsyncButton`);
        else if (waitingForm && tag === 'button') {
          const type = attr(n, 'type')?.initializer;
          if (!type || (ts.isStringLiteral(type) && type.text === 'submit')) at(n, '<button type="submit"> of a waiting form: use AsyncButton');
        }
      }
    }
    ts.forEachChild(n, (c) => visit(c, waitingForm));
  };
  visit(file, false);
  return found;
}

test('a button that waits shows it: AsyncButton, not a plain element', () => {
  const sources = program.getSourceFiles().filter((f) => f.fileName.startsWith(appRoot) && f.fileName.endsWith('.tsx'));
  assert.ok(sources.length > 50, 'reads src/app');
  assert.deepEqual(sources.flatMap(unmarked), []);
});
