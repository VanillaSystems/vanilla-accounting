# Einrichtung (the setup conversation)

The setup is a conversation in the AI sidebar: a specialist leads the owner topic by topic through the books (firm and VAT, fiscal year, opening, previous program, bank, receipts, partners and knowledge). Every step and card is drawn by code from the answers and the app's settings; only free text the code cannot place goes to the model. Answers live in `onboarding.json` at the workspace root; the turns in `data/assistant/<id>.json`.

## Sub-features

- `su-entry`: Firma's `.obentry > button.aiact`: `Einrichtung öffnen`, or `Einrichtung fortsetzen` with `n/7` once started and unfinished. A workspace never set up opens the setup by itself on first start (and so already reads `fortsetzen 0/7` on Firma).
- `su-panel`: `aside.aside.setup[aria-label="Einrichtung"]`, title `.obwho` `Einrichtung`, textarea placeholder `Antworte mit den Knöpfen oder schreib es in deinen Worten`.
- `su-rail`: `nav.obrail[aria-label="Was schon eingerichtet ist"]`, one `button` per topic (class `open|done|skipped`, `next`), `.obcount` `n von 7 erledigt`. A click opens the place to do it by hand: firm → `/company/vat`, periods → `/company/periods`, opening → `/company/opening`, bank → `/company/banks`, receipts → `/company/sources`, knowledge → `/company/rules`; `Bisheriges Programm` is disabled.
- `su-steps`: one step at a time (the VAT step follows only once `company` is answered): `.obstep[data-step=<id>]` with `.qacts button[data-answer=<value>]` (company: `ok` Stimmt so / `fix`) (`PUT /api/onboarding/answers/<q>`, no model); answered `.obstep[data-answered=<id>]` with `Ändern`. Cards `.obcard` (company `dl.obkv`, opening `table.obtable`, banks, sources, partners, summary with `[data-testid=setup-go]` `Los geht's`).
- `su-vat`: when the VAT answer (`data-answer` `none|effective|net-rate|unknown`) differs from the workspace: `.ruledraft.obvat[data-state=proposed|kept]` `MWST-Einstellung` `<the current setup> → <the answer>` (e.g. `MWST effektiv, pro Quartal, nach vereinnahmten Entgelten → nicht MWST-pflichtig`); net-rate asks `Bewilligter Satz in %` and `Wofür`. `Übernehmen` → `PATCH /api/workspace {vat}` (writes `company.vat` in `belege.workspace.yaml`) + `PUT /api/onboarding/answers/vat {value, kept}`; kept: `Übernommen. Steht jetzt unter Firma › MWST.` and `Rückgängig` (patches the old setup back). A refusal shows as `.warnline` on the card.

## How to get to it (user POV)

- Dock `Firma` (`G F`) › `Einrichtung öffnen` / `fortsetzen`.
- A new, empty workspace opens it on first start (the Mac app's setup ends there too, features/desktop-setup.md).

## Driving it with browse + sandbox.sh

Preconditions. Read-only checks run on the demo sandbox. A VAT change that is kept needs books whose open year has no entries: every demo has entries in 2026, so there `Übernehmen` is refused with `vatMethodHeld` (`Die MWST-Einstellung gilt für das ganze Jahr: 2026 hat schon … Buchungen …`). For the accepted path make an empty workspace in your scratch dir (never in the repo, never with the app's `.env`):

```bash
W=<scratchpad>/setup-ws
npm run init -- --preset consultant --dir "$W" --name "Verify Probe GmbH" --uid CHE-153.004.184 \
  --owner "Erika Beispiel" --bank UBS:CHF --no-env --yes      # git repo, no entries, VAT effective
VERIFY_WORKSPACE="$W" $S up setup && $S doctor setup        # empty books: doctor skips the PDF checks
```

- **Open.** `$B goto "$UI/company/profile"` (set the language first): on the empty workspace `aside.aside.setup` is already open (first start), `nav.obrail button` count is 7, `.obcount` reads `0 von 7 erledigt`, the only step is `company`. On the demo, `$B click '.obentry button.aiact'` opens it with `2 von 7 erledigt`.
- **Rail.** `$B js "document.querySelector('nav.obrail button:nth-child(2)').click()"` (Geschäftsjahr): the page goes to `/company/periods`.
- **Answer.** Click `.obstep[data-step=company] [data-answer=ok]`, then `.obstep[data-step=vat] [data-answer=none]`: `.obvat[data-state=proposed]` reads `MWST effektiv, pro Quartal, nach vereinnahmten Entgelten → nicht MWST-pflichtig`, buttons `Übernehmen`, `Zeigen`.
- **Keep and undo (write).** `cp "$SB/belege.workspace.yaml" "$SB.before.yaml"`, then `.obvat .btn.primary`: `data-state=kept`, `Übernommen. Steht jetzt unter Firma › MWST.`; `diff "$SB.before.yaml" "$SB/belege.workspace.yaml"` shows the four lines `registered: true`, `method`, `reporting`, `period` replaced by `registered: false`; `jq .answers.vat "$SB/onboarding.json"` has `kept.before`. `Rückgängig`: `data-state=proposed`, the manifest is byte-identical to the copy again, `kept` is gone (driven 2026-10-21).
- **Refusal.** On the demo sandbox the same steps end in `.obvat .warnline` `Die MWST-Einstellung gilt für das ganze Jahr: 2026 hat schon <n> Buchungen. Der Wechsel ist auf den 1.1.2027 möglich, …`; `cmp demo/vanilla-accounting/belege.workspace.yaml "$SB/belege.workspace.yaml"` is silent.

## Gotchas

- Free text that names no answer, and `Mit mir einrichten` on the sources card, call the model: in the sandbox that turn ends in `.msg.ai .warnline` (`claude exited 1: …`). `$S stub <run>` drives those turns with a canned answer, `$S unstub <run>` after.
- `npm run init` without `--no-env` points the app's `.env` at the new workspace: always pass `--no-env`, and `--dir` outside the repo. Without a terminal it needs `--preset` and a valid `--uid`.
- A label-only VAT change (the net-rate label) gives no card; it goes through Firma › MWST.
