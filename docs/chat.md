# Chat with Claude

The chat composer lets you ask Claude about the open books or start a bookkeeping job. It needs
Claude Code, set up under Firma › Claude ([desktop.md](desktop.md#claude-einrichten)).

## Use it

- Open or close it with **⌘J**, or with **Claude fragen** in the ⌘K palette. It floats at the
  bottom centre, above the dock. **Esc** closes it. Closed, it keeps the draft and the
  conversation.
- Type a question. **Enter** sends it, **Shift+Enter** starts a new line.
- Type **/** at the start to pick a job: one of the flows in `processes/*.flow.yaml`, in the order
  the quarter runs them (Belege sammeln, Eingang verarbeiten, Kontoauszüge importieren, …,
  Quartal abschliessen). Use ↑/↓ and Enter, or click. The job shows as a chip; Backspace in an
  empty field removes it.
- Attach files with **+**, by dropping them on the composer, or by pasting them. Each file shows
  as a chip with ✕ to remove it.
- The answer streams into the panel above the composer, with each file Claude reads or changes.
  The next message continues the same conversation. **Neu** starts a fresh one, **Stopp** ends a
  running answer.

## What Claude may do

The app runs the installed `claude` CLI (`src/chat/claude.ts`) in the workspace folder, with a
system prompt that tells it to follow the app's `AGENTS.md`, the workspace's
`docs/company/AGENTS.md` and the process guides. Its permissions, not the prompt, set the limits:

| Action | Allowed |
| --- | --- |
| Read, search any file of the workspace and the app's rules | yes |
| Edit or write under `knowledge/` (rules, precedents, businesses) | yes |
| Run the app's commands (`npm --prefix <app> run <script>`) | only when the app runs from its source (`npm start`, `npm run desktop`) |
| Edit `books.json`, `filings/`, a seal, anything else | no, refused and shown as *abgelehnt* in the answer |

The app's commands write the books through `src/books/store.ts`, which refuses closed periods
(`config.closedThrough`). The packaged Mac app has no npm, so there Claude says which change to
make in the app. The app loads the books again after each answer. In audit mode (`READONLY=1`)
the chat is not offered.

Attached files are saved under the workspace's `data/chat/<conversation>/` and named in the
message by that path; Claude reads them with its Read tool. Every answer's token use is appended
to `data/llm-ledger.jsonl` with the step `chat` (`npm run llm-usage`).

## Dictation

Dictation is left out of the MVP. macOS's own dictation works in the text field: press **Fn**
twice (or the dictation key), speak, and the text appears at the cursor. Nothing is sent until you
press Enter. A version with dictation built in (Whisper, transcribed on the computer) is kept on
the branch `feat/chat-voice`.

## Tests

- `tests/chat.test.ts`: the composer's state machine, the jobs from the flows, the message and
  CLI arguments, the stream-json parser, and the routes with the claude stub.
