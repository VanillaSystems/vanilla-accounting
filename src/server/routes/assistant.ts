/**
 * The AI sidebar over HTTP (src/assistant/). Answers stream as NDJSON, one event per line.
 *
 *   GET  /api/assistant        the conversations, newest first
 *   GET  /api/assistant/:id    one conversation with its turns
 *   POST /api/assistant        an AssistantSend → the answer's events
 */
import { Router, type Response } from 'express';
import { RequestError, WS } from '../books.js';
import { listConversations, readConversation, sendMessage } from '../../assistant/conversations.js';
import type { AssistantEvent, AssistantSend, ContextRef } from '../../types/assistant.js';

export const router = Router();

const KINDS = new Set<ContextRef['kind']>(['entry', 'payment', 'receipt', 'run', 'workflow', 'file']);

function sendOf(body: unknown): AssistantSend {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = typeof b.text === 'string' ? b.text : '';
  if (!text.trim()) throw new RequestError(400, 'Leere Nachricht.');
  if (b.mode !== 'ask' && b.mode !== 'change') throw new RequestError(400, 'mode: ask oder change.');
  const context = Array.isArray(b.context) ? b.context : [];
  if (context.length > 12 || !context.every((r): r is ContextRef => !!r && KINDS.has(r.kind) && typeof r.id === 'string' && typeof r.label === 'string')) {
    throw new RequestError(400, 'context: Verweise mit kind, id und label.');
  }
  return {
    text: text.slice(0, 20_000), mode: b.mode, context,
    ...(typeof b.conversation === 'string' && b.conversation ? { conversation: b.conversation } : {}),
    language: typeof b.language === 'string' ? b.language : 'de',
  };
}

function ndjson(res: Response): (e: AssistantEvent) => void {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.flushHeaders();
  return (e) => { res.write(JSON.stringify(e) + '\n'); };
}

router.get('/api/assistant', (_req, res) => {
  res.json(listConversations(WS));
});

router.get('/api/assistant/:id', (req, res) => {
  const c = readConversation(WS, req.params.id);
  if (!c) throw new RequestError(404, 'Dieses Gespräch gibt es nicht.');
  res.json(c);
});

router.post('/api/assistant', async (req, res) => {
  const send = sendOf(req.body);
  const emit = ndjson(res);
  const stop = new AbortController();
  res.on('close', () => { if (!res.writableFinished) stop.abort(); });
  await sendMessage(WS, send, emit, stop.signal);
  res.end();
});
