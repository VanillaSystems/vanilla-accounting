# KI (the AI sidebar)

The AI sidebar is a conversation with the model beside every area: the owner asks, attaches receipts or a folder, dictates, and the answer can carry changes (rules, bookings) shown as cards and links. In the sandbox the model never runs: the `claude` shim exits 1, so a sent message ends in an error turn. To drive the real code with a canned answer, `$S stub <run> [text-file]` swaps in `tests/support/stub-bin/claude` (no restart: the API spawns `claude` by `PATH` per call) and `$S unstub <run>` restores the shim.

## Sub-features

- `ai-toggle`: ⌘J (also Ctrl+J, even while typing) or `button[aria-label="KI öffnen"]` in the top-right corner (`.cornerbtn.aibtn`); panel `aside.aside[aria-label="KI"]`, header `Verlauf` (aria-pressed), `Neu`, close `[aria-label=Schliessen]`.
- `ai-send`: `textarea[aria-label="Nachricht an die KI"]`, Enter or `button.aisend[aria-label=Senden]` (aria-disabled when empty; `Stopp` while sending). `POST /api/assistant` (NDJSON stream). Turns `.aiturns .msg.me` / `.msg.ai .aitext`; waiting `Denkt nach …`; an error is `.msg.ai .warnline`.
- `ai-attach`: `button.aiplus[aria-label="Verweis hinzufügen"]` (picker with `Datei anhängen …`), hidden `input[type=file][data-testid=attach-input]` (png, jpg, gif, webp, heic, heif, pdf), chips `[data-testid=attachment-chip]`; upload `POST /api/assistant/attachments?name=…` lands in `$SB/data/assistant/attachments/pending/<id>/<name>`, moved to `attachments/<conversation>/<id>/` when sent. Sent: `[data-testid=sent-attachment]` with `Als Beleg übernehmen`.
- `ai-drop`: files dropped right of the sidebar's left edge (or within 88 px of the right edge while it is closed) attach to the chat (overlay `[data-testid=drop-chat]`); a folder is walked, at most 50 files, other types counted as skipped.
- `ai-dictate`: `button.aimic[data-testid=dictate]` (`Diktieren` / `Diktieren beenden`, aria-pressed), where the browser has `SpeechRecognition`, and in the Mac app when its bridge offers on-device `dictate` (src/app/assistant/dictation.ts, src/desktop/dictation.swift).
- `ai-links`: in an answer only `http(s)://` links (bare or `[text](https://…)`) become `<a target=_blank rel="noopener noreferrer">`; change rows have `Zeigen` (in-app) and `Herunterladen` (`a[download]`).

- `ai-open-period` (#342): `section.openp[data-testid=open-period]` before the first message of an ordinary conversation (also without an AI) and under an answer whose block has `{"kind":"openPeriod"}`: `h3` «Stand Q3 2026», the return's day («Abrechnung fällig am 29.11.2026»), `li[data-line=unbooked|questions|evidence|unlinked|task]` each an `a.linkbtn` to the first object (`/payments/<ref>?period=…`), `small` «davon warten n auf ihren Beleg»; nothing open: `[data-testid=open-period-none]`. The message's prompt carries «Where the oldest period not filed stands …» (keep it with `CLAUDE_STUB_PROMPTS` in the stub's wrapper). Driven 2026-11-12 on an empty workspace with the persona's camt.053 dropped: 23 payments, 20 waiting, due 29.11.2026, and the stubbed answer showed the card with no «Gemacht» line.

## How to get to it (user POV)

⌘J anywhere, the `KI öffnen` button in the top-right corner, `Die KI fragen` on a partner's notes, and Firma › `Einrichtung` (features/setup.md, the same panel in setup mode).

## Driving it with browse + sandbox.sh

Preconditions: a demo sandbox. For a real answer, `$S stub <run> <text-file>` before the send (doctor then says `api finds the test stub as claude (stubbed)`), `$S unstub <run>` after.

- **Open.** `$B goto "$UI/journal"`, `$B press Meta+j`: on the demo, whose setup is not finished (2 von 7), this opens `aside.aside.setup[aria-label=Einrichtung]`; click its `Neu` to get `aside.aside[aria-label=KI]` (driven 2026-10-31). After «Los geht's» (`[data-testid=setup-go]`) ⌘J opens `aside.aside[aria-label=KI]` at 400 px, also after a reload (#342, driven 2026-11-12). `$B press Meta+j` again closes it.
- **Send (shim).** `$B fill 'textarea[aria-label="Nachricht an die KI"]' "Hallo"`, `$B press Enter`: `.msg.me` reads `Hallo`, then `.msg.ai .warnline` contains `claude exited 1: verify sandbox: no model calls`; `ls "$SB"/data/assistant/*.json` lists the conversation (stored before the model call).
- **Send (stub) and links.** `printf 'Mehr unter [Hilfe](https://example.com/hilfe).\n' > <scratch>/stub.md`, `$S stub <run> <scratch>/stub.md`, click `Neu`, send `Hallo`: the answer reads `Mehr unter Hilfe.` and `Stub-Antwort auf «Hallo». Ein neues Gespräch.`; `$B js "const a=document.querySelector('.msg.ai a'); a.href+' '+a.target+' '+a.rel"` is `https://example.com/hilfe _blank noopener noreferrer`. Then `$S unstub <run>`.
- **Attach.** `$B upload '[data-testid=attach-input]' "$SB/transactional-data/2026/receipts/<file>.pdf"`: one `[data-testid=attachment-chip]`, the file in `$SB/data/assistant/attachments/pending/`; after a send, `[data-testid=sent-attachment]`.
- **Dictation presence.** `$B js "!!document.querySelector('[data-testid=dictate]') === !!(window.SpeechRecognition||window.webkitSpeechRecognition)"` is `true` (gstack's Chromium has `webkitSpeechRecognition`, so the button shows).

## Gotchas

- The model call is the only path that needs `claude`; opening, attaching and the error turn need none.
- A browser without `SpeechRecognition`, and a Mac app build without the recognizer, show no mic button. That is the rule, not a bug.
- The composer is enabled only when the column's CLI probe passes. The probe (src/server/ai-setup.ts, `probeAll`) looks on the login shell's PATH, not the API's, so it finds a real signed-in `claude` on the host (running only `--version` and `auth status`); on a machine without one the column shows `[data-testid=column-no-ai]` «Keine KI auf diesem Mac.» and the send recipes cannot run.
- Never change Firma › KI's provider or CLI in the sandbox. The sandbox shims both `claude` and `codex` (doctor: `api finds the refusing codex shim, no CLI pinned`); an API key entered there could still reach a provider.
- The sent message carries the selected object of the area as a reference (`Hallo` plus the entry's text).
- `$S unstub` after a stubbed drive, so later drives cannot reach even the stub by accident.
