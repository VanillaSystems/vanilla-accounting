/**
 * The one loader of sources (ADR 0014): APP_ROOT/sources/* and the workspace's sources/*. It never
 * runs code to learn what a source declares: reach and feeds come from source.yaml, parsed
 * strictly with line numbers, so a person can approve a source by reading it. The code is checked
 * statically here and runs only in a child process (a later unit).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { LineCounter, parseDocument, isMap, isSeq, isScalar, type Node } from 'yaml';
import { CADENCES, type ApiReach, type FeedDecl, type MailReach, type Problem, type Reach, type SourceDecl, type Text, type WebReach } from './model.js';
import { parseHostPath, parseSender } from './reach.js';

const ID = /^[a-z][a-z0-9-]*$/;

/** One source folder's declaration, or every problem with its file and line. */
export function readDecl(folder: string, origin: 'app' | 'company', appSources: string): { decl: SourceDecl } | { problems: Problem[] } {
  const id = folder.split('/').pop()!;
  const file = join(folder, 'source.yaml');
  const name = `sources/${id}/source.yaml`;
  if (!ID.test(id)) return { problems: [{ file: `sources/${id}`, message: 'a source folder is lower case letters, digits and dashes' }] };
  if (!existsSync(file)) return { problems: [{ file: name, message: 'no source.yaml' }] };
  const text = readFileSync(file, 'utf8');
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  const problems: Problem[] = doc.errors.map((e) => ({ file: name, line: e.linePos?.[0].line, message: e.message.split('\n')[0] }));
  if (problems.length) return { problems };
  const lineOf = (n: Node | null | undefined) => (n?.range ? lines.linePos(n.range[0]).line : undefined);
  const fail = (n: Node | null | undefined, message: string) => { problems.push({ file: name, line: lineOf(n), message }); };
  const root = doc.contents;
  if (!isMap(root)) return { problems: [{ file: name, line: 1, message: 'source.yaml is a map: label, code, settings, reach, feeds' }] };
  const keys = (map: Node | null | undefined, allowed: string[], where: string) => {
    if (!isMap(map)) { fail(map, `${where}: a map`); return; }
    for (const it of map.items) { const k = String((it.key as { value?: unknown })?.value); if (!allowed.includes(k)) fail(it.key as Node, `${where}: unknown key "${k}" (allowed: ${allowed.join(', ')})`); }
  };
  keys(root, ['label', 'code', 'settings', 'reach', 'feeds', 'bindable'], 'source.yaml');
  const get = (path: Array<string | number>) => doc.getIn(path, true) as Node | undefined;
  const plain = doc.toJS() as Record<string, unknown>;
  const value = (path: Array<string | number>): unknown => path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string | number, unknown>)[k] : undefined), plain);
  const strings = (path: Array<string | number>, what: string): string[] => {
    const n = get(path);
    if (n === undefined) return [];
    if (!isSeq(n) || !n.items.every((x) => isScalar(x) && typeof x.value === 'string')) { fail(n, `${what}: a list of texts`); return []; }
    return n.items.map((x) => String((x as { value: unknown }).value));
  };

  const rawLabel = value(['label']);
  const label: Text = typeof rawLabel === 'string' ? { en: rawLabel } : rawLabel && typeof rawLabel === 'object' && typeof (rawLabel as Text).en === 'string' ? rawLabel as Text : { en: id };

  const codeText = value(['code']);
  let code: SourceDecl['code'] | undefined;
  if (typeof codeText !== 'string') fail(get(['code']) ?? root, 'code: ./<file>.ts, or app:<id> for code the app ships');
  else if (codeText.startsWith('app:')) {
    const bound = codeText.slice(4);
    if (!ID.test(bound) || !existsSync(join(appSources, bound, 'source.yaml'))) fail(get(['code']), `code: the app ships no source "${bound}"`);
    else code = { kind: 'app', id: bound };
  } else if (/^\.\/[A-Za-z0-9._/-]+\.ts$/.test(codeText) && !codeText.includes('..')) {
    if (!existsSync(join(folder, codeText))) fail(get(['code']), `code: ${codeText} is not in the folder`);
    else code = { kind: 'own', entry: codeText };
  } else fail(get(['code']), 'code: ./<file>.ts inside the folder, or app:<id>');

  const reach: Reach = {};
  const r = get(['reach']);
  if (r !== undefined) {
    keys(r, ['mail', 'web', 'api'], 'reach');
    if (get(['reach', 'mail']) !== undefined) {
      keys(get(['reach', 'mail']), ['host', 'account', 'folders', 'from', 'skip'], 'reach.mail');
      const senders = (k: 'from' | 'skip') => strings(['reach', 'mail', k], `reach.mail.${k}`).flatMap((s) => { const p = parseSender(s); if (!p.ok) { fail(get(['reach', 'mail', k]), p.message); return []; } return [p.value]; });
      const host = value(['reach', 'mail', 'host']), account = value(['reach', 'mail', 'account']);
      if (typeof host !== 'string' || typeof account !== 'string') fail(get(['reach', 'mail']), 'reach.mail: host and account');
      const mail: MailReach = { host: String(host), account: String(account), folders: strings(['reach', 'mail', 'folders'], 'reach.mail.folders'), from: senders('from'), skip: senders('skip') };
      if (!mail.folders.length) mail.folders = ['INBOX'];
      if (!mail.from.length) fail(get(['reach', 'mail']), 'reach.mail.from: the senders it may read ("*" for anyone)');
      reach.mail = mail;
    }
    if (get(['reach', 'web']) !== undefined) {
      keys(get(['reach', 'web']), ['start', 'sign-in', 'open', 'download'], 'reach.web');
      const paths = (k: string) => strings(['reach', 'web', k], `reach.web.${k}`).flatMap((s) => { const p = parseHostPath(s); if (!p.ok) { fail(get(['reach', 'web', k]), p.message); return []; } return [p.value]; });
      const web: WebReach = { signIn: paths('sign-in'), open: paths('open'), download: paths('download') };
      const start = value(['reach', 'web', 'start']);
      if (typeof start === 'string') web.start = start;
      reach.web = web;
    }
    if (get(['reach', 'api']) !== undefined) {
      keys(get(['reach', 'api']), ['base', 'scopes', 'auth', 'allow'], 'reach.api');
      const base = value(['reach', 'api', 'base']);
      if (typeof base !== 'string' || !base.startsWith('https://') || !base.endsWith('/')) fail(get(['reach', 'api', 'base']) ?? get(['reach', 'api']), 'reach.api.base: an https address ending in /');
      const header = value(['reach', 'api', 'auth', 'header']);
      const allow = strings(['reach', 'api', 'allow'], 'reach.api.allow').flatMap((line) => {
        const m = /^GET\s+(\S+)$/.exec(line);
        if (!m) { fail(get(['reach', 'api', 'allow']), `reach.api.allow: "GET <path>", got "${line}" (reading only)`); return []; }
        const p = parseHostPath(`${String(base).replace(/^https:\/\//, '')}${m[1]}`);
        if (!p.ok) { fail(get(['reach', 'api', 'allow']), p.message); return []; }
        return [{ method: 'GET' as const, path: { ...p.value, text: m[1] } }];
      });
      const api: ApiReach = { base: String(base), scopes: strings(['reach', 'api', 'scopes'], 'reach.api.scopes'), auth: typeof header === 'string' ? { header } : { bearer: true }, allow };
      reach.api = api;
    }
  }

  const feeds: FeedDecl[] = [];
  const f = get(['feeds']);
  if (!isMap(f) || !f.items.length) fail(f ?? root, 'feeds: at least one, each with output and every');
  else for (const it of f.items) {
    const fid = String((it.key as { value?: unknown }).value);
    if (!ID.test(fid)) { fail(it.key as Node, `feeds: "${fid}" is lower case letters, digits and dashes`); continue; }
    keys(it.value as Node, ['output', 'every'], `feeds.${fid}`);
    const output = value(['feeds', fid, 'output']), every = value(['feeds', fid, 'every']);
    const o = typeof output === 'string' ? output.trim().split(/\s+/) : [];
    const decl: FeedDecl['output'] | undefined = o[0] === 'document' || o[0] === 'rebuilt' ? { kind: o[0] } : o[0] === 'records' && /^[a-z]+\.[a-z-]+@\d+$/.test(o[1] ?? '') ? { kind: 'records', record: o[1] } : undefined;
    if (!decl) fail(get(['feeds', fid, 'output']) ?? (it.value as Node), `feeds.${fid}.output: document, rebuilt, or records <kind>@<version>`);
    if (!CADENCES.includes(every as never)) fail(get(['feeds', fid, 'every']) ?? (it.value as Node), `feeds.${fid}.every: ${CADENCES.join(', ')}`);
    if (decl && CADENCES.includes(every as never)) feeds.push({ id: fid, output: decl, every: every as FeedDecl['every'] });
  }

  if (code?.kind === 'own') problems.push(...checkCode(folder, code.entry).map((p) => ({ ...p, file: `sources/${id}/${p.file}` })));
  if (problems.length || !code) return { problems };
  const files = code.kind === 'own' ? walk(folder, code.entry).files : [];
  const bound = code.kind === 'app' ? versionOf(join(appSources, code.id), walkBound(join(appSources, code.id))) : undefined;
  const settings = (value(['settings']) ?? {}) as Record<string, unknown>;
  return { decl: { id, label, origin, code, settings, reach, feeds, version: versionOf(folder, files, bound) } };
}

const walkBound = (folder: string): string[] => {
  const entry = (() => { try { const c = parseDocument(readFileSync(join(folder, 'source.yaml'), 'utf8')).get('code'); return typeof c === 'string' ? c : undefined; } catch { return undefined; } })();
  return entry && existsSync(join(folder, entry)) ? walk(folder, entry).files : [];
};

const IMPORT = /^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/;
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bimport\s*\(/, 'a dynamic import'], [/\brequire\s*\(/, 'require'], [/\beval\s*\(/, 'eval'], [/\bFunction\s*\(/, 'Function(…)'], [/\.constructor\s*\(/, '.constructor(…)'],
  [/\bprocess\b/, 'process'], [/\bglobalThis\s*\[/, 'globalThis[…]'], [/\bgetBuiltinModule\b/, 'getBuiltinModule'],
];

/** The files the entry can load: itself and its relative imports, transitively, all inside the folder. */
function walk(folder: string, entry: string): { files: string[]; problems: Problem[] } {
  const files: string[] = [];
  const problems: Problem[] = [];
  const visit = (rel: string) => {
    if (files.includes(rel)) return;
    files.push(rel);
    const path = join(folder, rel);
    if (!existsSync(path)) { problems.push({ file: rel, message: 'imported, but not in the folder' }); return; }
    const src = readFileSync(path, 'utf8');
    try { stripTypeScriptTypes(src); } catch (e) { problems.push({ file: rel, message: `TypeScript the app cannot run as it is: ${(e as Error).message.split('\n')[0]}` }); }
    src.split('\n').forEach((line, i) => {
      const m = IMPORT.exec(line);
      const spec = m?.[3] ?? m?.[4];
      if (spec && !m?.[2]) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) problems.push({ file: rel, line: i + 1, message: `imports "${spec}": a source loads only its own files` });
        else {
          const target = relative(folder, resolve(dirname(path), spec.replace(/\.js$/, '.ts')));
          if (target.startsWith('..')) problems.push({ file: rel, line: i + 1, message: `imports "${spec}", outside the source's folder` });
          else visit(target);
        }
      }
      for (const [re, what] of FORBIDDEN) if (re.test(line.replace(/\/\/.*$/, ''))) problems.push({ file: rel, line: i + 1, message: `${what} is not allowed in a source` });
    });
  };
  visit(entry.replace(/^\.\//, ''));
  return { files, problems };
}

/** The static check of a source's code (ADR 0014): what the fence would refuse, with file and line, before anything runs. */
export function checkCode(folder: string, entry: string): Problem[] {
  return walk(folder, entry).problems;
}

/** sha16 over source.yaml and every file the code can load, and the bound app code's version. */
export function versionOf(folder: string, files: string[], bound?: string): string {
  const h = createHash('sha256').update(readFileSync(join(folder, 'source.yaml')));
  for (const f of [...files].sort()) h.update(`\0${f}\0`).update(readFileSync(join(folder, f)));
  if (bound) h.update(`\0bound\0${bound}`);
  return h.digest('hex').slice(0, 16);
}

/** The source folders under `dir`, without the app's generated `.vanilla/`. */
export const folders = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((d) => !d.startsWith('.') && statSync(join(dir, d)).isDirectory()).sort() : []);
