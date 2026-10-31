/**
 * The KI column's file tools for Codex, served by the app (an MCP server over HTTP on 127.0.0.1,
 * one per message, at a path no other program knows). Codex itself has no file, shell or web tool
 * in the sidebar (src/llm/providers/codex-cli.ts CLOSED), so these are all it can reach: the same
 * five tools under the same names and the same bounds the Claude sidebar's permissions set
 * (src/assistant/claude.ts assistantArgs):
 *
 *  - Read, Glob, Grep: the books' folder, the app's own files and the company's repository.
 *  - Write, Edit: only the draft's copy of a customizing folder (data/draft/<name>/…), never the
 *    chart's draft. The books, the ledger, the receipts and the records stay out of reach: a change
 *    to them is named in the answer's ```vanilla-changes block, which the app applies through its
 *    write door (closed periods, seals, a person's bookings: src/books/store.ts), as for Claude.
 *
 * A PDF is read as its own text and its first pages drawn as images (src/parsers/pdf-pages.ts).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, globSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { pdfPages } from '../parsers/pdf-pages.js';
import { pdfText } from '../parsers/pdf-text.js';

export interface ToolBounds {
  /** Where relative paths start: the books' folder. */
  root: string;
  /** What Read, Glob and Grep may open. */
  readable: string[];
  /** What Write and Edit may change: patterns relative to `root`, and those never. */
  writable: string[];
  never: string[];
  /** Where drawn PDF pages are cached. */
  pagesCache: string;
}

export interface ToolServer {
  url: string;
  close(): Promise<void>;
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Args = Record<string, unknown>;

const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024;
const MAX_HITS = 200;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

class Refused extends Error {}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v) throw new Refused(`${name} fehlt`);
  return v;
};

/** The real path of `p`, or of its nearest existing folder joined with the rest (a file Write makes). */
function real(p: string): string {
  let dir = p;
  const rest: string[] = [];
  while (!existsSync(dir)) {
    rest.unshift(dir.slice(dirname(dir).length + 1));
    if (dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return join(realpathSync(dir), ...rest);
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

export function toolBounds(b: ToolBounds) {
  const roots = b.readable.filter(existsSync).map((d) => realpathSync(d));
  const root = realpathSync(b.root);
  const at = (p: unknown, name = 'file_path') => {
    const given = str(p, name);
    return real(isAbsolute(given) ? given : resolve(b.root, given));
  };
  const readable = (p: unknown, name?: string) => {
    const path = at(p, name);
    if (!roots.some((r) => inside(path, r))) throw new Refused(`außerhalb der Buchhaltung: ${String(p)}`);
    return path;
  };
  const writable = (p: unknown) => {
    const path = at(p);
    const rel = inside(path, root) ? relative(root, path).split(sep).join('/') : undefined;
    if (!rel || b.never.includes(rel) || !b.writable.some((g) => matchesGlob(rel, g))) {
      throw new Refused(`nicht erlaubt: ${String(p)}. Schreiben geht nur in den Entwurf (${b.writable.slice(0, 3).join(', ')} …); Änderungen an den Büchern gehören in den vanilla-changes-Block`);
    }
    return path;
  };
  return { readable, writable, root };
}

function numbered(text: string, offset: number, limit: number): string {
  const lines = text.split('\n');
  const from = Math.max(0, offset - 1);
  const part = lines.slice(from, from + limit);
  const out = part.map((l, i) => `${from + i + 1}\t${l}`).join('\n');
  return from + limit < lines.length ? `${out}\n… (${lines.length} Zeilen, mit offset und limit weiterlesen)` : out;
}

const isText = (buf: Buffer) => !buf.subarray(0, 8000).includes(0);

/** The five tools: what Codex is told about each, and what each does. */
export function tools(b: ToolBounds) {
  const bounds = toolBounds(b);
  const list = [
    { name: 'Read', description: 'Read a file of the books folder, the app\'s files or the company\'s repository (path absolute or relative to the books folder). Text comes with line numbers; a PDF as its text and its first pages as images; an image as itself.', inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number', description: 'first line, 1-based' }, limit: { type: 'number' } }, required: ['file_path'] } },
    { name: 'Glob', description: 'Files whose path matches a glob pattern (e.g. "transactional-data/2026/books/*.jsonl"), under `path` (default: the books folder).', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
    { name: 'Grep', description: 'Lines matching a regular expression in the text files under `path` (default: the books folder), optionally only files matching `glob`.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, ignore_case: { type: 'boolean' } }, required: ['pattern'] } },
    { name: 'Write', description: 'Write a whole file. Only the draft\'s copy of a customizing file or folder (data/draft/…), never the books: those change through your vanilla-changes block.', inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
    { name: 'Edit', description: 'Replace old_string by new_string in a file of the draft (data/draft/…); old_string must occur once unless replace_all.', inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string', 'new_string'] } },
  ];

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name === '.git' || d.name === 'node_modules') continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p, out);
      else if (d.isFile()) out.push(p);
      if (out.length > 20_000) break;
    }
    return out;
  };

  const run: Record<string, (a: Args) => Promise<Content[]>> = {
    async Read(a) {
      const path = bounds.readable(a.file_path);
      const ext = extname(path).toLowerCase();
      if (ext === '.pdf') {
        const { total, pages } = await pdfPages(path, b.pagesCache);
        const text = (await pdfText(path).catch(() => '')).trim().slice(0, MAX_BYTES);
        return [
          { type: 'text', text: `PDF, ${total} Seite(n); Bilder der Seiten ${pages.map((p) => p.page).join(', ')}.\n${text ? `Text:\n${text}` : 'Ohne Textebene (ein Scan): aus den Bildern lesen.'}` },
          ...pages.map((p): Content => ({ type: 'image', data: readFileSync(p.file).toString('base64'), mimeType: 'image/png' })),
        ];
      }
      const buf = readFileSync(path);
      if (IMAGE_TYPES[ext]) return [{ type: 'image', data: buf.toString('base64'), mimeType: IMAGE_TYPES[ext] }];
      if (!isText(buf)) return [{ type: 'text', text: `${relative(bounds.root, path)}: keine Textdatei (${buf.length} Bytes)` }];
      return [{ type: 'text', text: numbered(buf.subarray(0, MAX_BYTES * 4).toString('utf8'), Number(a.offset) || 1, Number(a.limit) || MAX_LINES) }];
    },
    async Glob(a) {
      const base = a.path ? bounds.readable(a.path, 'path') : bounds.root;
      const hits = globSync(str(a.pattern, 'pattern'), { cwd: base }).map((p) => join(base, p))
        .filter((p) => { try { return statSync(p).isFile() && bounds.readable(p) !== undefined; } catch { return false; } });
      return [{ type: 'text', text: hits.slice(0, 500).join('\n') || 'keine Datei' }];
    },
    async Grep(a) {
      const base = a.path ? bounds.readable(a.path, 'path') : bounds.root;
      const re = new RegExp(str(a.pattern, 'pattern'), a.ignore_case ? 'i' : '');
      const glob = typeof a.glob === 'string' && a.glob ? a.glob : undefined;
      const files = statSync(base).isFile() ? [base] : walk(base);
      const hits: string[] = [];
      for (const f of files) {
        if (glob && !matchesGlob(relative(base, f), glob) && !matchesGlob(f.slice(f.lastIndexOf(sep) + 1), glob)) continue;
        if (statSync(f).size > 4 * MAX_BYTES) continue;
        const buf = readFileSync(f);
        if (!isText(buf)) continue;
        buf.toString('utf8').split('\n').forEach((line, i) => { if (hits.length < MAX_HITS && re.test(line)) hits.push(`${f}:${i + 1}:${line.slice(0, 300)}`); });
        if (hits.length >= MAX_HITS) break;
      }
      return [{ type: 'text', text: hits.join('\n') || 'kein Treffer' }];
    },
    async Write(a) {
      const path = bounds.writable(a.file_path);
      const content = typeof a.content === 'string' ? a.content : str(a.content, 'content');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return [{ type: 'text', text: `geschrieben: ${relative(bounds.root, path)}` }];
    },
    async Edit(a) {
      const path = bounds.writable(a.file_path);
      const old = str(a.old_string, 'old_string');
      const now = readFileSync(path, 'utf8');
      const count = now.split(old).length - 1;
      if (count === 0) throw new Refused('old_string kommt in der Datei nicht vor');
      if (count > 1 && !a.replace_all) throw new Refused(`old_string kommt ${count}-mal vor: mehr Umfeld angeben oder replace_all`);
      writeFileSync(path, a.replace_all ? now.split(old).join(String(a.new_string ?? '')) : now.replace(old, () => String(a.new_string ?? '')));
      return [{ type: 'text', text: `geändert: ${relative(bounds.root, path)}` }];
    },
  };
  return { list, run };
}

interface Rpc { jsonrpc?: string; id?: string | number | null; method?: string; params?: Args }

/**
 * Starts the tools' server for one message. Only POSTs to its own random path from this computer,
 * without a browser's Origin and with its own Host, are answered.
 */
export function serveTools(b: ToolBounds): Promise<ToolServer> {
  const { list, run } = tools(b);
  const path = `/mcp/${randomBytes(24).toString('hex')}`;
  const answer = async (m: Rpc): Promise<object | undefined> => {
    if (m.id === undefined || m.id === null) return undefined;
    const ok = (result: object) => ({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize': return ok({ protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'vanilla', version: '1' } });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: list });
      case 'tools/call': {
        const name = String(m.params?.name ?? '');
        const tool = run[name];
        if (!tool) return ok({ content: [{ type: 'text', text: `kein Werkzeug ${name}` }], isError: true });
        try {
          return ok({ content: await tool((m.params?.arguments ?? {}) as Args) });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: e instanceof Refused ? `Abgelehnt: ${e.message}` : `Fehler: ${(e as Error).message}` }], isError: true });
        }
      }
      default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } };
    }
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const host = `127.0.0.1:${(server.address() as { port: number }).port}`
    if (req.url !== path || req.headers.origin || req.headers.host !== host) return void res.writeHead(404).end();
    if (req.method === 'DELETE') return void res.writeHead(200).end();
    if (req.method !== 'POST') return void res.writeHead(405).end();
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 8 * MAX_BYTES) req.destroy(); });
    req.on('end', async () => {
      let parsed: Rpc | Rpc[];
      try { parsed = JSON.parse(body) as Rpc | Rpc[]; } catch { return void res.writeHead(400).end(); }
      const replies = (await Promise.all((Array.isArray(parsed) ? parsed : [parsed]).map(answer))).filter(Boolean);
      if (!replies.length) return void res.writeHead(202).end();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    });
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      done({ url: `http://127.0.0.1:${port}${path}`, close: () => new Promise((closed) => { server.closeAllConnections(); server.close(() => closed()); }) });
    });
  });
}
