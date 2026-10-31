/**
 * The questions' file in each year folder, transactional-data/<year>/questions.jsonl: lines are
 * appended, never rewritten (src/questions/model.ts). An event goes to the year it happens in, or
 * the first open year after it, like the run log: a closed year's folder is never written again.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { yearPaths, yearsOf, type Workspace } from '../workspace/workspace.js';
import { openYear, yearOfDate } from '../books/years.js';
import { fold, parseLine, type Question, type QuestionLine } from './model.js';

/** Every line of every year; a line that does not parse (another version, a broken merge) is skipped. */
export function readLines(ws: Pick<Workspace, 'paths'>): QuestionLine[] {
  return yearsOf(ws.paths).flatMap((y) => {
    const path = yearPaths(ws.paths, y).questions;
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { const line = parseLine(JSON.parse(l)); return line ? [line] : []; } catch { return []; }
    });
  });
}

export const readQuestions = (ws: Pick<Workspace, 'paths'>): Question[] => fold(readLines(ws));

export function appendQuestionLine(ws: Pick<Workspace, 'paths'>, line: QuestionLine, closedThrough: string | undefined): void {
  const path = yearPaths(ws.paths, openYear(yearOfDate(line.at), closedThrough)).questions;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`);
}
