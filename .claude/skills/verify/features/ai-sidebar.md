# KI (the AI sidebar)

The AI sidebar is a conversation with the model beside every area: the owner asks, attaches receipts or a folder, dictates, and the answer can carry changes (rules, bookings) shown as cards and links. In the sandbox the model never runs: the `claude` shim exits 1, so a sent message ends in an error turn. To drive the real code with a canned answer, `$S stub <run> [text-file]` swaps in `tests/support/stub-bin/claude` (no restart: the API spawns `claude` by `PATH` per call) and `$S unstub <run>` restores the shim.

## Sub-features

- `ai-toggle`: ⌘J (also Ctrl+J, even while typing) or `button[aria-label="KI öffnen"]` in the top-right corner (`.cornerbtn.aibtn`); panel `aside.aside[aria-label="KI"]`, header `Verlauf` (aria-pressed), `Neu`, close `[aria-label=Schliessen]`.
- `ai-send`: `textarea[aria-label="Nachricht an die KI"]`, Enter or `button.aisend[aria-label=Senden]` (aria-disabled when empty; `Stopp` while sending). `POST /api/assistant` (NDJSON stream). Turns `.aiturns .msg.me` / `.msg.ai .aitext`; waiting `Denkt nach …`; an error is `.msg.ai .warnline`.
- `ai-attach`: `button.aiplus[aria-label="Verweis hinzufügen"]` (picker with `Datei anhängen …`), hidden `input[type=file][data-testid=attach-input]` (png, jpg, gif, webp, heic, heif, pdf), chips `[data-testid=attachment-chip]`; upload `POST /api/assistant/attachments?name=…` lands in `$SB/data/assistant/attachments/pending/<id>/<name>`, moved to `attachments/<conversation>/<id>/` when sent. Sent: `[data-testid=sent-attachment]` with `Als Beleg übernehmen`.
- `ai-drop`: files dropped right of the sidebar's left edge (or within 88 px of the right edge while it is closed) attach to the chat (overlay `[data-testid=drop-chat]`); a folder is walked, at most 50 files, other types counted as skipped.
- `ai-dictate`: `button.aimic[data-testid=dictate]` (`Diktieren` / `Diktieren beenden`, aria-pressed), only where the browser has `SpeechRecognition` and never in the Mac app.
- `ai-links`: in an answer only `http(s)://` links (bare or `[text](https://…)`) become `<a target=_blank rel="noopener noreferrer">`; change rows have `Zeigen` (in-app) and `Herunterladen` (`a[download]`).

## How to get to it (user POV)

⌘J anywhere, the `KI öffnen` button in the top-right corner, `Die KI fragen` on a partner's notes, and Firma › `Einrichtung` (features/setup.md, the same panel in setup mode).

## Driving it with browse + sandbox.sh

Preconditions: a demo sandbox. For a real answer, `$S stub <run> <text-file>` before the send (doctor then says `api finds the test stub as claude (stubbed)`), `$S unstub <run>` after.

- **Open.** `$B goto "$UI/journal"`, `$B press Meta+j`: `aside.aside[aria-label=KI]` is visible. `$B press Meta+j` again closes it.
- **Send (shim).** `$B fill 'textarea[aria-label="Nachricht an die KI"]' "Hallo"`, `$B press Enter`: `.msg.me` reads `Hallo`, then `.msg.ai .warnline` contains `claude exited 1: verify sandbox: no model calls`; `ls "$SB"/data/assistant/*.json` lists the conversation (stored before the model call).
- **Send (stub) and links.** `printf 'Mehr unter [Hilfe](https://example.com/hilfe).\n' > <scratch>/stub.md`, `$S stub <run> <scratch>/stub.md`, click `Neu`, send `Hallo`: the answer reads `Mehr unter Hilfe.` and `Stub-Antwort auf «Hallo». Ein neues Gespräch.`; `$B js "const a=document.querySelector('.msg.ai a'); a.href+' '+a.target+' '+a.rel"` is `https://example.com/hilfe _blank noopener noreferrer`. Then `$S unstub <run>`.
- **Attach.** `$B upload '[data-testid=attach-input]' "$SB/transactional-data/2026/receipts/<file>.pdf"`: one `[data-testid=attachment-chip]`, the file in `$SB/data/assistant/attachments/pending/`; after a send, `[data-testid=sent-attachment]`.
- **Dictation presence.** `$B js "!!document.querySelector('[data-testid=dictate]') === !!(window.SpeechRecognition||window.webkitSpeechRecognition)"` is `true` (gstack's Chromium has `webkitSpeechRecognition`, so the button shows).

## Gotchas

- The model call is the only path that needs `claude`; opening, attaching and the error turn need none.
- A browser without `SpeechRecognition`, and the Mac app, show no mic button. That is the rule, not a bug.
- `$S unstub` after a stubbed drive, so later drives cannot reach even the stub by accident.
