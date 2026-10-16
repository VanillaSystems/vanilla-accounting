/**
 * Questions between the people who keep the books (src/server/questions.ts):
 *
 *   GET  /api/questions                 every question, the people to pick from, the owner's account
 *   POST /api/questions                 { on, by, text, choices?, to? } → the question
 *   POST /api/questions/:id/answer      { by, choice } or { by, text } → the question, with what the app did
 *   POST /api/questions/:id/undo        { by } → the answer's bookings and precedent taken back, open again
 *   POST /api/questions/:id/close       { by, how: done | withdrawn }
 */
import { Router } from 'express';
import { RequestError, WS, readBooks } from '../books.js';
import { ownerAccount } from '../../accounting/bank-accounts.js';
import { readQuestions } from '../../questions/store.js';
import { peopleOf, type Question, type QuestionsView } from '../../questions/model.js';
import { APP_ASKER, closeGoneSaleQuestions, goneSaleQuestions } from '../../intake/sale-questions.js';
import { answerQuestion, askQuestion, closeQuestion, parseAnswer, parseAsk, undoAnswer } from '../questions.js';

export const router = Router();

const by = (body: unknown): string => {
  const v = (body as { by?: unknown } | undefined)?.by;
  if (typeof v !== 'string' || !v.trim()) throw new RequestError(400, 'by fehlt.');
  return v.trim();
};

/**
 * The questions as they stand: the app's question about a sale whose reason went away (a receipt
 * linked, the quarter filed) is closed first, saying why; in read-only mode it only shows closed.
 */
function current(): Question[] {
  const questions = readQuestions(WS);
  if (!questions.some((q) => q.topic === 'saleVat' && q.status === 'open')) return questions;
  const books = readBooks();
  if (process.env.READONLY !== '1') return closeGoneSaleQuestions(WS, books) ? readQuestions(WS) : questions;
  const at = new Date().toISOString();
  const gone = new Map(goneSaleQuestions(questions, books).map(({ q, why }) => [q.id, why]));
  return questions.map((q) => (gone.has(q.id) ? { ...q, status: 'closed' as const, closed: { by: APP_ASKER, at, how: 'withdrawn' as const, why: gone.get(q.id)! } } : q));
}

router.get('/api/questions', (_req, res) => {
  const questions = current();
  res.json({ questions, people: peopleOf(WS.company.owner, questions), owner: ownerAccount(WS) } satisfies QuestionsView);
});

router.post('/api/questions', (req, res) => {
  res.json(askQuestion(parseAsk(req.body)));
});

router.post('/api/questions/:id/answer', (req, res) => {
  res.json(answerQuestion(req.params.id, parseAnswer(req.body)));
});

router.post('/api/questions/:id/undo', (req, res) => {
  res.json(undoAnswer(req.params.id, by(req.body)));
});

router.post('/api/questions/:id/close', (req, res) => {
  const how = (req.body as { how?: unknown } | undefined)?.how;
  if (how !== 'done' && how !== 'withdrawn') throw new RequestError(400, 'how: done oder withdrawn.');
  res.json(closeQuestion(req.params.id, by(req.body), how));
});
