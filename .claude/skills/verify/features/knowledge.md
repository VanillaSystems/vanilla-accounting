# Wissen

Wissen (`/knowledge[/<page>]`) is how the company works, in its own words: one page per topic (`knowledge/company/<slug>.md`), the gaps where the app could not go on alone this year (Lücken), and what the app brings along for every company (Von der App, read only). No page calls a model.

## Sub-features

- `kn-list`: rows `.row.fset[role=option][data-page=gaps|app|t:<slug>]` (selected `.sel`): `Lücken` with `n offen` (`.kwwarn` when n > 0), `Von der App` with `nur lesen`, then the group `Arbeitsweise` with one row per topic. `/knowledge` selects Lücken.
- `kn-gaps`: `/knowledge/gaps`: `.kwstats .kwstat` ×4 (Zahlungen gebucht, von einer Regel gebucht, Zahlungen ohne Geschäftspartner, offene Fragen), `table.kwtable tr[data-decider=rule|code|model|person|unknown]` (Wer hat gebucht), `ul.kwgaplist` for open questions (partner links; the section head links `Zu den Aufgaben`) and for payments without a partner (`Beispiel vom …`, `Regel anlegen` → Firma › Regeln `?payment=`).
- `kn-app`: `/knowledge/app`: `details.kwapp` per partner of the app (`deine Partnerseite` link when the workspace knows it) and per process, `.kwstep h4` per step.
- `kn-topic`: `/knowledge/<slug>`: `h2.who` with `Arbeitsweise · Schritt …`, the notes block of Geschäftspartner (`[data-act="edit-notes"]`, textarea, `Speichern`; `POST /api/notes {ref:{kind:'topic',slug}}` writes `knowledge/company/<slug>.md`, its front matter's values kept), `section.kwself` with the company rules of the named steps, `details.kwdetails`.
- `kn-new`: `button[data-act="new-page"]` (Neue Seite) → `form.kwnewform` (one input, placeholder `z. B. Fahrzeug und Privatanteil`, `Anlegen`/`Abbrechen`). It writes `knowledge/company/<slug>.md` (slug from the title, `-2` when taken) and goes to `/knowledge/<slug>`, toast `Seite angelegt.`. An empty title toasts `Eine Seite braucht einen Titel.`

## How to get to it (user POV)

Dock `Wissen` (`G E`), or ⌘K. No other area links here.

## Driving it with browse + sandbox.sh

Preconditions: a fresh demo sandbox. Demo topics: `belege-sammeln` (step `receipt-collection#triage`), `fahrzeug` (steps `booking#eigenverbrauch`, `booking#private`), `mwst-abrechnung` (no step).

- **Gaps.** `$B goto "$UI/knowledge"`: the URL becomes `/knowledge/gaps`; `$B js "document.querySelectorAll('.kwstats .kwstat').length"` is 4; `tr[data-decider]` rows exist.
- **App page.** `$B click '[data-page=app]'`: URL `/knowledge/app`, `details.kwapp` present, no `Bearbeiten`.
- **Topic.** `$B goto "$UI/knowledge/fahrzeug"`: `h2.who` reads `Fahrzeug und Privatanteil`; `$B goto "$UI/knowledge/mwst-abrechnung"`: `section.kwself` says the page names no step.
- **Edit a topic (write).** On `/knowledge/fahrzeug`, `Bearbeiten`, append a sentence (caret via `$B js`, see features/partners.md), `Speichern`. Proof: `diff demo/vanilla-accounting/knowledge/company/fahrzeug.md "$SB/knowledge/company/fahrzeug.md"` shows the added sentence. The front matter's `steps: [a, b]` comes back as a block list (`steps:` / `  - a`): same values, other YAML style (seen 2026-10-21).
- **New page (write).** `$B click '[data-act="new-page"]'`, `$B fill '.kwnewform input' "Verify Probe"`, `$B click '.kwnewform .btn.primary'`: URL `/knowledge/verify-probe`, `$SB/knowledge/company/verify-probe.md` is `---`, `title: Verify Probe`, `---`; a new row `[data-page="t:verify-probe"]`, toast `Seite angelegt.`

## Gotchas

- A slug is never `gaps` or `app`; such a title gets `<slug>-seite`, a taken one `-2`.
- Topic pages offer no «Als Regel vorschlagen» and show no marks; that is Geschäftspartner only.
- In audit mode (`READONLY=1`) `Neue Seite` and `Bearbeiten` are hidden; in the static audit export the page says `Im Prüfexport nicht enthalten: diese Seite liest die App.`
