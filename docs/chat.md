# Chat with Claude

The chat composer lets you ask Claude about the open books, start a bookkeeping job, or dictate.
It needs Claude Code, set up under Firma › Claude ([desktop.md](desktop.md#claude-einrichten)).
Dictation needs no Claude and works offline after one download.

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
- Click the microphone to dictate. The bars show the microphone level. ✕ discards the recording,
  ✓ turns it into text in the field. Nothing is sent until you press Enter.
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

The page records the microphone as mono PCM at 16 kHz (`src/app/shell/chat/recorder.ts`) and
sends it to the app's own local server, which transcribes it with Whisper small, 8-bit quantized
(`onnx-community/whisper-small`), through transformers.js on onnxruntime-node
(`src/chat/transcribe.ts`). The audio never leaves the computer. The language follows the app's
language (de, fr, it, en).

The model (about 250 MB) downloads from Hugging Face on the first dictation; the busy state shows
the progress. It is kept in the Mac app's user data folder (`models/`), or in
`~/.cache/vanilla-accounting/models` for `npm start`. `VANILLA_MODELS_DIR` sets another folder.

Measured on an Apple M3 for a 9.8 s German clip: 1.1 to 1.3 s per transcription in Node with the
model loaded (0.6 s to load it from disk), and 1.5 to 1.7 s from ✓ to the text in the dev Mac
app. whisper-base took 0.5 s but misheard words ("boche", "Swisskom"), so the app uses
whisper-small.

The Mac app asks macOS for the microphone once (`NSMicrophoneUsageDescription`, entitlement
`com.apple.security.device.audio-input`). Inside the app, only the app's own pages get the
microphone and no other device (`src/desktop/permissions.ts`). In the browser, the browser asks.

## Tests

- `tests/chat.test.ts`: the composer's state machine, the jobs from the flows, the message and
  CLI arguments, the stream-json parser, and the routes with the claude stub.
- `tests/transcribe.test.ts`: German speech from macOS `say`, transcribed. It is skipped unless the
  model is already in `VANILLA_MODELS_DIR`, since a test does not download it.
