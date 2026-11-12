# Einrichtung (the setup conversation)

The setup is a conversation in the AI sidebar: a specialist leads the owner through what the settings and the first bank statement do not tell the app (the opening, the bank while no account has an IBAN, receipts, partners once there are bookings); the firm, its VAT setup and what it sells are shown once, not asked. Every step and card is drawn by code from the answers and the app's settings; only free text the code cannot place goes to the model. Answers live in `onboarding.json` at the workspace root; the turns in `data/assistant/<id>.json`.

## Sub-features

- `su-entry`: Firma's `.obentry > button.aiact`: `Einrichtung öffnen`, or `Einrichtung fortsetzen` with `n/5` once started and unfinished (topics done or left for later). A workspace never set up opens the setup by itself on first start.
- `su-panel`: `aside.aside.setup[aria-label="Einrichtung"]`, title `.obwho` `Einrichtung`, textarea placeholder `Antworte mit den Knöpfen oder schreib es in deinen Worten` (with AI off, or no CLI the column accepts, `In eigenen Worten schreiben geht erst mit einer KI.` and the textarea disabled).
- `su-rail`: `nav.obrail[aria-label="Was schon eingerichtet ist"]`, one `button` per topic (class `open|done|skipped`, `next`), `.obcount[data-progress]` `n von m besprochen`: the topics the conversation took up that are done or left for later, of those it took up (`setupCount`); on books without bookings «Partner und Wissen» is not taken up, so `m` is 4 (#364). A click opens the place to do it by hand: firm → `/company/vat`, opening → `/company/opening`, bank → `/company/banks`, receipts → `/company/sources`, knowledge → `/company/rules`.
- `su-steps`: `.obstep[data-step=<id>]` with `.qacts button[data-answer=<value>]` (`PUT /api/onboarding/answers/<q>`, no model); answered `.obstep[data-answered=<id>]` with `Ändern`. The first step `company` asks nothing: greeting without a name, the card `dl.obkv` (name, UID, legal form, owner, MWST, Verkauft) and the link `[data-answer=fix]` `Etwas ändern`, which opens `vat` and then, with a sales profile, `sells` (toggles `[data-answer=made|traded|services]` with `role=checkbox`, `[data-act=sells-next]` «Weiter», card `.ruledraft.obsells[data-state]` «Übernehmen»). Then `opening` (`later` answers with what «Später» means), `bank` only while no account has an IBAN, `receipts`, `partners` only with bookings (src/onboarding/model.ts). The summary `[data-testid=setup-summary]` starts with `Dein erster Schritt` (`[data-first]`, one sentence), `[data-testid=setup-statement]` `Kontoauszug einlesen` (ends the setup, closes the sidebar, goes to `/bank`), `[data-testid=setup-go]` `Erst umsehen` and `details.obmore` «Mehr dazu»; then `Eingerichtet`, `Noch offen` (`li[data-open=<topic>]`, state `später`, or `kommt mit den ersten Buchungen` for partners never shown). After an answer the newest step scrolls into sight, the summary to its top. Without an AI (`useNoAi`, or the column's CLI blocked) the greeting ends «Du antwortest mit einem Klick.» and the receipts card shows `[data-testid=sources-no-ai]` with `[data-act=ai-set-up]` «KI einrichten» instead of `[data-act=sources-ask]` «Mit mir einrichten».
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

- **Open.** `$B goto "$UI/company/profile"` (set the language first): on the empty workspace `aside.aside.setup` is already open (first start), `nav.obrail button` count is 5, the steps are `company` (shown) and `opening`; with a bank that has an IBAN `.obcount` reads `2 von 4 besprochen` (two clicks, `later` twice, reach the summary at `4 von 4`; tests/setup-help-browser.test.ts drives it at 1440 × 900 and 1024 × 768).
- **Rail.** `$B js "document.querySelector('nav.obrail button:nth-child(2)').click()"` (Eröffnung): the page goes to `/company/opening`.
- **Answer.** Click `.obstep[data-step=company] [data-answer=fix]`, then `.obstep[data-step=vat] [data-answer=none]`: `.obvat[data-state=proposed]` reads `MWST effektiv, pro Quartal, nach vereinnahmten Entgelten → nicht MWST-pflichtig`, buttons `Übernehmen`, `Zeigen`.
- **Keep and undo (write).** `cp "$SB/belege.workspace.yaml" "$SB.before.yaml"`, then `.obvat .btn.primary`: `data-state=kept`, `Übernommen. Steht jetzt unter Firma › MWST.`; `diff "$SB.before.yaml" "$SB/belege.workspace.yaml"` shows the four lines `registered: true`, `method`, `reporting`, `period` replaced by `registered: false`; `jq .answers.vat "$SB/onboarding.json"` has `kept.before`. `Rückgängig`: `data-state=proposed`, `kept` is gone; the manifest is the copy plus one line `reportingSince: <year>` under `company.vat` (a known product bug of 2026-10-31: the undo goes through `PATCH /api/workspace`, which records a basis switch).
- **Refusal.** On the demo sandbox the same steps end in `.obvat .warnline` `Die MWST-Einstellung gilt für das ganze Jahr: 2026 hat schon <n> Buchungen. Der Wechsel ist auf den 1.1.2027 möglich, …`; `cmp demo/vanilla-accounting/belege.workspace.yaml "$SB/belege.workspace.yaml"` is silent.

## Gotchas

- Free text that names no answer, and `Mit mir einrichten` on the sources card, call the model: in the sandbox that turn ends in `.msg.ai .warnline` (`claude exited 1: …`). `$S stub <run>` drives those turns with a canned answer, `$S unstub <run>` after.
- `npm run init` without `--no-env` points the app's `.env` at the new workspace: always pass `--no-env`, and `--dir` outside the repo. Without a terminal it needs `--preset` and a valid `--uid`.
- A label-only VAT change (the net-rate label) gives no card; it goes through Firma › MWST.
