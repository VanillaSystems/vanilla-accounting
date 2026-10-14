/**
 *   GET  /api/changes?since=<rev>               ChangesView, or { unchanged: true }; same rev as /api/automation (one clock)
 *   POST /api/changes                          { command: SavingCommand } → SavingResult
 *
 * And the two other servers' routes, same pattern:
 *   GET  /api/assistant/conversations          Conversation[]
 *   GET  /api/assistant/conversations/:id      meta + events
 *   POST /api/assistant                        NDJSON stream of AssistantEvent (feat/chat's POST /api/chat, renamed)
 *   POST /api/drop                             new session; POST /api/drop/:id { command } → DropSession (multipart for add-files)
 */
import { Router } from 'express';

export const router = Router();
