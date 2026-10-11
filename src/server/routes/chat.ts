/**
 * The chat composer (src/app/shell/chat/): the jobs of the "/" menu, attached files, a message to
 * Claude with its answer streamed back. Nothing here writes the books: Claude changes them only
 * through the app's commands (src/chat/claude.ts). Answers stream as NDJSON, one event per line.
 */
import express, { Router, type Response } from 'express';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { chatSkills } from '../../chat/skills.js';
import { runChat } from '../../chat/claude.js';
import type { ChatEvent, ChatFile, ChatSend, ChatSkill } from '../../types/chat.js';
import { RequestError, WS } from '../books.js';

export const router = Router();

const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const chatDir = (conversation: string) => join(WS.paths.data, 'chat', conversation);

function conversationOf(value: unknown): string {
  if (typeof value !== 'string' || !CONVERSATION.test(value)) throw new RequestError(400, 'conversation muss eine UUID sein.');
  return value;
}

function ndjson<E>(res: Response): (e: E) => void {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.flushHeaders();
  return (e) => { res.write(JSON.stringify(e) + '\n'); };
}

router.get('/api/chat/skills', (_req, res) => {
  res.json(chatSkills() satisfies ChatSkill[]);
});

/** A file for the conversation, kept under data/chat/<conversation>/ by its own name (a second one of that name gets -2). */
router.post('/api/chat/files', express.raw({ type: () => true, limit: '50mb' }), (req, res) => {
  const conversation = conversationOf(req.query.conversation);
  const given = basename(String(req.query.name ?? '')).replace(/[\u0000-\u001f]/g, '').trim().slice(-120) || 'datei';
  const dir = chatDir(conversation);
  mkdirSync(dir, { recursive: true });
  const ext = extname(given);
  let name = given;
  for (let n = 2; existsSync(join(dir, name)); n++) name = `${given.slice(0, given.length - ext.length)}-${n}${ext}`;
  writeFileSync(join(dir, name), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  res.json({ path: relative(WS.paths.root, join(dir, name)) } satisfies ChatFile);
});

function sendOf(body: unknown): ChatSend {
  const b = (body ?? {}) as Record<string, unknown>;
  const conversation = conversationOf(b.conversation);
  const prefix = relative(WS.paths.root, chatDir(conversation)) + '/';
  const files = Array.isArray(b.files) ? b.files : [];
  if (!files.every((f): f is string => typeof f === 'string' && f.startsWith(prefix) && !f.includes('..'))) {
    throw new RequestError(400, `files: nur Dateien unter ${prefix}`);
  }
  const text = typeof b.text === 'string' ? b.text : '';
  const skill = typeof b.skill === 'string' && b.skill ? b.skill : undefined;
  if (!text.trim() && !skill && !files.length) throw new RequestError(400, 'Leere Nachricht.');
  return {
    conversation, text, files,
    ...(skill ? { skill } : {}),
    ...(typeof b.session === 'string' && b.session ? { session: b.session } : {}),
    language: typeof b.language === 'string' ? b.language : 'de',
  };
}

router.post('/api/chat', async (req, res) => {
  const send = sendOf(req.body);
  const emit = ndjson<ChatEvent>(res);
  const stop = new AbortController();
  res.on('close', () => { if (!res.writableFinished) stop.abort(); });
  await runChat(send, { root: WS.paths.root, skills: chatSkills(), onEvent: emit, signal: stop.signal });
  res.end();
});
