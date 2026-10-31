// The child a source's code runs in (ADR 0014), plain JavaScript so the plain node of the CLI and
// the Mac app's utility process run it alike. Its only door is the IPC channel: the host sends
// `start`, answers `call`s and says `next` after each yielded item. Before the source loads, the
// network globals and `process` are taken away; the permission model (--permission, read-only to
// the source's folder and this file) refuses writes, child processes and workers. Node cannot deny
// the network, so this is a fence against mistakes, not a boundary against malice.
import { registerHooks } from 'node:module';

const send = process.send.bind(process);
const on = process.on.bind(process);

// A source imports its own files as './x.js' (as TypeScript does); they are './x.ts' on disk.
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (e) {
      if (spec.endsWith('.js')) return next(spec.replace(/\.js$/, '.ts'), ctx);
      throw e;
    }
  },
});

let waiting;
let calls = 0;
const pending = new Map();
on('message', (m) => {
  if (m.type === 'start') void run(m);
  else if (m.type === 'reply') { const p = pending.get(m.id); pending.delete(m.id); if (p) (m.ok ? p.resolve(m.value) : p.reject(new Error(m.error))); }
  else if (m.type === 'next') { const w = waiting; waiting = undefined; w?.(); }
});

/** A channel's method, run by the host: the code holds no connection, no session and no secret. */
const channel = (name) => new Proxy({}, {
  get: (_t, method) => (...args) => new Promise((resolve, reject) => {
    const id = ++calls;
    pending.set(id, { resolve, reject });
    send({ type: 'call', id, channel: name, method: String(method), args });
  }),
});

const out = {
  document: (file, o = {}) => ({ kind: 'document', file, key: o.key, date: o.date }),
  record: (record, o = {}) => ({ kind: 'record', record, key: o.key }),
  checkpoint: (cursor) => ({ kind: 'checkpoint', cursor }),
};

async function run({ entry, feed, from, settings }) {
  for (const name of ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'Request', 'Response', 'Headers', 'navigator', 'Worker', 'SharedArrayBuffer']) delete globalThis[name];
  delete globalThis.process;
  try {
    const mod = await import(entry);
    const feeds = mod.default ?? {};
    if (typeof feeds[feed] !== 'function') throw new Error(`the code has no feed "${feed}"`);
    const io = { mail: channel('mail'), web: channel('web'), api: channel('api'), out, settings: Object.freeze(settings ?? {}), log: (text) => send({ type: 'log', text: String(text) }) };
    for await (const item of feeds[feed](io, from)) {
      send({ type: 'yield', item });
      await new Promise((resolve) => { waiting = resolve; });
    }
    send({ type: 'end' });
  } catch (e) {
    send({ type: 'error', message: String(e && e.message || e), code: e && e.code });
  }
}
