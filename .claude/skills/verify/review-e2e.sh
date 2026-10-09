#!/usr/bin/env bash
# The Treuhänder's review end to end on demo-consulting (features/accountant-review.md):
# a sandbox workspace made a git repository, the review package built from it and served
# statically, one correction of every v1 kind (docs/accountant-corrections.md) made in the
# browser, the review file downloaded through the real button, imported and merged in the
# owner's Reviews tab, then the git graph and the VAT figures checked against the preview.
#
#   .claude/skills/verify/review-e2e.sh [run-id]      evidence in .verify/evidence/<run>/
#
# Uses its own browse server (BROWSE_STATE_FILE), so it never drives another session's tab.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
RUN="${1:-review}"
S="$REPO/.claude/skills/verify/sandbox.sh"
export BROWSE_STATE_FILE="${TMPDIR%/}/review-browse-$RUN/state.json" BROWSE_PORT="${BROWSE_PORT:-9431}"
mkdir -p "$(dirname "$BROWSE_STATE_FILE")"
B="$(command -v browse || echo "$HOME/.claude/skills/gstack/browse/dist/browse")"
SHOTS="${TMPDIR%/}/review-shots-$RUN"; rm -rf "$SHOTS"; mkdir -p "$SHOTS"

VERIFY_WORKSPACE="$REPO/demo-consulting" "$S" up "$RUN" >/dev/null
source "${TMPDIR%/}/belege-verify/$RUN/env"
OUT="$EVIDENCE"; mkdir -p "$OUT"
log() { printf '\n== %s\n' "$*" | tee -a "$OUT/run.log"; }

log "the sandbox workspace becomes a git repository (the owner's books)"
( cd "$SB"
  printf 'data/\napi.log\napi.pid\nui.log\nui.pid\nbin/\nenv\nindex.snapshot.json\n' > .gitignore
  git init -q -b main && git config user.name "Lukas Beispiel" && git config user.email "lukas@example.ch"
  git add -A && git commit -q -m "Bücher der Muster Consulting GmbH bis 2026-Q3" )
cp "$SB/books.json" "$OUT/books-before.json"

log "npm run review -- 2026-Q3 --for \"Anna Muster\" --email anna@example.ch <package>"
( cd "$REPO" && VANILLA_WORKSPACE="$SB" node --import tsx src/cli/review.ts package 2026-Q3 --for "Anna Muster" --email anna@example.ch "$OUT/package" 2>&1 | grep -v '^\(- \|(!)\)' | tee -a "$OUT/run.log" )
PORT=$((UI_PORT + 100))
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$OUT/package" >"$SB/../serve-$RUN.log" 2>&1 &
SERVE_PID=$!
trap 'kill $SERVE_PID 2>/dev/null || true' EXIT
PKG="http://127.0.0.1:$PORT/index.html"
sleep 1

# Fixture records, by their text, from the snapshot.
id() { node -e "const b=require('$SB/books.json');const e=b.journalEntries.find(e=>e.date.startsWith('$1')&&(e.description||'').includes('$2'));if(!e)process.exit(1);console.log(e.id)"; }
FIXDESK_JUL=$(id 2026-07 'Fixdesk Juli'); TELECOM_JUL=$(id 2026-07 'Mobile-Abo Juli'); SOFTWARE_JUL=$(id 2026-07 'Projektplanung Juli')
PARKING=$(id 2026-08 'Parkhaus'); FEE_Q3=$(id 2026-09 'Kontoführung'); SOFTWARE_AUG=$(id 2026-08 'Projektplanung August')
FIXDESK_AUG=$(id 2026-08 'Fixdesk August'); SBB_AUG=$(id 2026-08 'SBB'); TELECOM_JAN=$(id 2026-01 'Mobile-Abo Januar'); FIXDESK_JAN=$(id 2026-01 'Fixdesk Januar')
TREUHAND_JUL=$(id 2026-07 'Beratungsmandat Juli')
ref() { node -e "const b=require('$SB/books.json');console.log(b.journalEntries.find(e=>e.id==='$1').transactionRef)"; }
BVG_REF=$(node -e "const b=require('$SB/books.json');console.log(b.transactions.find(t=>t.date.startsWith('2026-07')&&t.description.includes('BVG')).ref)")
TELECOM_JUL_REF=$(ref "$TELECOM_JUL"); TELECOM_AUG_REF=$(node -e "const b=require('$SB/books.json');console.log(b.journalEntries.find(e=>e.date.startsWith('2026-08')&&(e.description||'').includes('Mobile-Abo August')).transactionRef)")
TELECOM_JAN_REF=$(ref "$TELECOM_JAN")
TELECOM_JUL_RECEIPT=$(node -e "const b=require('$SB/books.json');console.log(b.mappings.find(m=>m.transactionRef==='$TELECOM_JUL_REF').receiptId)")

shot() { "$B" screenshot --viewport "$SHOTS/$1.png" >/dev/null; cp "$SHOTS/$1.png" "$OUT/$1.png"; echo "  screenshot $1.png" | tee -a "$OUT/run.log"; }
go() { "$B" goto "$1" >/dev/null; "$B" wait --networkidle >/dev/null; sleep 0.6; }
dbl() { "$B" js "document.querySelector('$1').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); 'ok'" >/dev/null; }
reason() { "$B" fill '[data-testid=review-ask] textarea' "$1" >/dev/null; if [ -n "${2:-}" ]; then shot "$2"; fi; "$B" click '[data-testid=review-ask-ok]' >/dev/null; sleep 0.4; echo "  correction: $1" | tee -a "$OUT/run.log"; }
inline() { dbl "tr[data-rowid=\"$1\"] td:nth-child($2) span[title=\"Doppelklick: bearbeiten\"]"; "$B" fill "tr[data-rowid=\"$1\"] td:nth-child($2) input" "$3" >/dev/null; "$B" press Enter >/dev/null; sleep 0.4; }
F='[data-testid=entry-form]'
form() { "$B" js "document.querySelector('tr[data-rowid=\"$1\"] button[data-action=edit]').click(); 'ok'" >/dev/null; sleep 0.4; }
pick() { "$B" click "$F [data-line=\"$1\"] [data-field=$2] [role=combobox]" >/dev/null; "$B" type "$3" >/dev/null; "$B" press Enter >/dev/null; sleep 0.2; }
save() { "$B" click '[data-testid=entry-form-save]' >/dev/null; sleep 0.4; }
cell() { "$B" js "document.querySelector('tr[data-rowid=\"$1\"] td:nth-child($2)').innerText"; }

"$B" viewport 1600x1000 >/dev/null
go "$PKG#/de/2026-Q3/journal-entries"
"$B" js "localStorage.setItem('splitpane:journal-entries','62'); location.reload(); 'ok'" >/dev/null; sleep 1.5
shot 00-package-journal

log "row 1: Soll account (inline)"
inline "$FIXDESK_JUL" 3 6500
reason "Fixdesk ist Büroaufwand: Konto 6500 statt 6000 (Kontierungsrichtlinie)" 01-soll-dialog
echo "  Soll now: $(cell "$FIXDESK_JUL" 3)" | tee -a "$OUT/run.log"
log "row 2: VAT code I81 -> I0 (inline)"
inline "$TELECOM_JUL" 7 I0
reason "Rechnung Muster Telecom Juli zeigt keine Schweizer MWST: I0 statt I81" 02-vat-i0-dialog
log "row 3: Bezugsteuer B81-1 (inline)"
inline "$SOFTWARE_JUL" 7 B81-1
reason "Beispiel Software (Berlin) ist nicht im MWST-Register: Bezugsteuer B81-1" 03-bezugsteuer-dialog
log "row 5: description (inline)"
inline "$PARKING" 2 "Parkhaus Beispiel, Kundenbesuch Muster Logistik (Quittung verloren)"
reason "Beschreibung ergänzt: welcher Kundenbesuch"
log "row 11: date Q3 -> Q2 (entry form)"
form "$FIXDESK_JUL"; "$B" fill "$F input[name=date]" 2026-06-30 >/dev/null; sleep 0.3; shot 11-date-form; save
reason "Bezahlt am 30.06.: das Zahlungsdatum entscheidet (vereinnahmt), gehört ins Q2"
log "row 9: amount (entry form)"
form "$FEE_Q3"; "$B" fill "$F [data-line=\"0\"] input[name=amount]" 15.00 >/dev/null; sleep 0.3; save
reason "Kontoführung Q3 laut Bankauszug CHF 15.00, nicht 12.00"
log "row 22: exchange rate (entry form)"
form "$SOFTWARE_AUG"; "$B" fill "$F input[name=exchangeRate]" 0.9389 >/dev/null; sleep 0.3; shot 22-fx-form; save
reason "ESTV-Devisenkurs Verkauf am Zahlungstag ist 0.9389"
log "row 10: split, business and private part (entry form)"
form "$FIXDESK_AUG"; "$B" click '[data-testid=entry-form-add-line]' >/dev/null
"$B" fill "$F [data-line=\"0\"] input[name=amount]" 380 >/dev/null
pick 1 accountDebit 2451
"$B" fill "$F [data-line=\"1\"] input[name=amount]" 60 >/dev/null
"$B" fill "$F [data-line=\"1\"] input[name=description]" "Privatanteil Fixdesk August" >/dev/null; sleep 0.3
shot 10-split-refused
"$B" fill "$F [data-line=\"0\"] input[name=amount]" 390 >/dev/null; sleep 0.3
shot 10-split-form; save
reason "Ein Tag im August privat genutzt: CHF 60.00 zulasten Kontokorrent Gesellschafter, ohne Vorsteuer"
log "row 12: reverse an open duplicate"
"$B" js "document.querySelector('tr[data-rowid=\"$SBB_AUG\"] button[title=\"Löschen\"]').click(); 'ok'" >/dev/null; sleep 0.4
reason "SBB August doppelt erfasst (gleiche Quittung wie Juli)" 12-reverse-open-dialog
log "row 13 and 12: correct and reverse entries of the filed Q1"
go "$PKG#/de/2026-Q1/journal-entries"
inline "$TELECOM_JAN" 7 I0
reason "Q1: Telecom-Rechnung Januar ohne MWST-Ausweis" 13-filed-edit-dialog
echo "  Q1 entry still: $(cell "$TELECOM_JAN" 7)" | tee -a "$OUT/run.log"
"$B" js "document.querySelector('tr[data-rowid=\"$FIXDESK_JAN\"] button[title=\"Löschen\"]').click(); 'ok'" >/dev/null; sleep 0.4
reason "Q1: Fixdesk Januar doppelt gebucht (die Rechnung Dezember deckt den Januar)" 12-reverse-filed-dialog
go "$PKG#/de/2026-Q2/journal-entries"
shot 13-corrects-entries-in-open-period
log "row 4: private share K81-B (new entry)"
go "$PKG#/de/2026-Q3/journal-entries"
"$B" click '[data-testid=journal-new-entry]' >/dev/null; sleep 0.4
pick 0 accountDebit 2451; pick 0 accountCredit 6510
"$B" fill "$F [data-line=\"0\"] input[name=amount]" 43.24 >/dev/null
"$B" fill "$F [data-line=\"0\"] input[name=vatCode]" K81-B >/dev/null
"$B" fill "$F [data-line=\"0\"] input[name=description]" "Privatanteil 40% Mobile-Abo Q3 2026" >/dev/null; sleep 0.3
shot 04-new-entry-private-share; save
reason "Privatanteil Mobile 40% (Präzedenzfall), Vorsteuerkorrektur Ziffer 415"
log "rows 15-24: year-end entry on an account of the SME chart (depreciation)"
"$B" click '[data-testid=journal-new-entry]' >/dev/null; sleep 0.4
"$B" click "$F [data-line=\"0\"] [data-field=accountDebit] input[type=checkbox]" >/dev/null
pick 0 accountDebit 6800; pick 0 accountCredit 1520
"$B" fill "$F [data-line=\"0\"] input[name=amount]" 600 >/dev/null
"$B" fill "$F [data-line=\"0\"] input[name=description]" "Abschreibung Laptop 2026, 25% von 2'400" >/dev/null; sleep 0.3
shot 17-depreciation-form; save
reason "Jahresabschluss: Abschreibung Büromaschinen 25% linear"
log "row 14: kein Beleg nötig"
go "$PKG#/de/2026-Q3/transactions?tx=$BVG_REF"
"$B" click 'button[title="Als «kein Beleg nötig» bestätigen"]' >/dev/null; sleep 0.4
reason "BVG-Beiträge: Beleg ist die Jahresrechnung der Sammelstiftung"
log "row 6: unlink and link a receipt; a link in the filed Q1 is refused"
go "$PKG#/de/2026-Q3/transactions?tx=$TELECOM_JUL_REF"
"$B" click 'button[title="Zuordnung entfernen"]' >/dev/null; sleep 0.4
reason "Rechnung MT-202607 gehört nicht zu dieser Zahlung"
go "$PKG#/de/2026-Q3/transactions?tx=$TELECOM_AUG_REF"
"$B" fill 'input[placeholder="Beleg suchen (Dateiname, Beschreibung)…"]' "Mobile-Abo Juli" >/dev/null; sleep 0.4
"$B" js "[...document.querySelectorAll('button[title=\"Zuordnen\"]')].find(b=>b.innerText.includes('Mobile-Abo Juli')).click(); 'ok'" >/dev/null; sleep 0.4
reason "Rechnung MT-202607 belegt die August-Zahlung (Abo im Voraus)" 06-link-dialog
go "$PKG#/de/2026-Q1/transactions?tx=$TELECOM_JAN_REF"
"$B" fill 'input[placeholder="Beleg suchen (Dateiname, Beschreibung)…"]' "Mobile-Abo Juli" >/dev/null; sleep 0.4
"$B" js "[...document.querySelectorAll('button[title=\"Zuordnen\"]')].find(b=>b.innerText.includes('Mobile-Abo Juli')).click(); 'ok'" >/dev/null; sleep 0.6
"$B" dialog | grep alert | tee -a "$OUT/run.log"
log "row 7: comments on an entry and on a receipt"
go "$PKG#/de/2026-Q3/journal-entries"
"$B" js "document.querySelector('tr[data-rowid=\"$TREUHAND_JUL\"] button[data-action=comment]').click(); 'ok'" >/dev/null; sleep 0.4
reason "Ist der Vertrag mit der Beispiel Treuhand AG für 2026 verlängert? Bitte nachreichen." 07-comment-dialog
go "$PKG#/de/2026-Q3/receipts?receipt=$TELECOM_JUL_RECEIPT"
"$B" click '[data-testid=comment-receipt]' >/dev/null; sleep 0.4
reason "Die Rechnung nennt Juli und August: bitte prüfen."
log "row 8: sign-off, message, Review abschicken"
go "$PKG#/de/2026-Q3/review"
"$B" fill 'input[name=statement]' "Q3 geprüft: mit diesen Korrekturen kann die Abrechnung eingereicht werden." >/dev/null
"$B" click '[data-testid=review-sign-off]' >/dev/null
"$B" fill '[data-testid=review-tab] textarea' "Q3 geprüft. Zwei Korrekturen betreffen das eingereichte Q1 (Korrekturabrechnung 0535)." >/dev/null; sleep 0.3
shot 08-review-tab
"$B" js "window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{window.__blobs.push(b);return o(b)};'ok'" >/dev/null
"$B" click '[data-testid=review-submit]' >/dev/null; sleep 0.6
"$B" js "window.__blobs[0].text()" --raw > "$OUT/review-2026-Q3-anna-muster.json"
node -e "const f=require('$OUT/review-2026-Q3-anna-muster.json');console.log('  review file:', f.corrections.length, 'corrections,', f.comments.length, 'comments,', f.signOffs.length, 'sign-off; kinds', [...new Set(f.corrections.map(c=>c.kind))].join(' '))" | tee -a "$OUT/run.log"
go "$PKG#/de/2026-Q3/vat-report"; shot 09-package-vat-q3
go "$PKG#/de/2026-Q3/log"; shot 09-package-protokoll

log "owner: Reviews tab, drop the file, the PR view"
go "$UI/de/2026-Q3/reviews"
"$B" upload '[data-testid=reviews-file]' "$OUT/review-2026-Q3-anna-muster.json" >/dev/null; sleep 2
"$B" js "document.querySelector('[data-testid=reviews-message]').innerText" | tee -a "$OUT/run.log"
shot 20-owner-pr-view
"$B" js "[...document.querySelectorAll('[data-correction]')].map(e=>e.dataset.correction+':'+e.dataset.status).join(' ')" | tee -a "$OUT/run.log"
log "owner: reject one with a reason, merge all applicable"
K4=$(node -e "const f=require('$OUT/review-2026-Q3-anna-muster.json');console.log(f.corrections.find(c=>c.reason.startsWith('Beschreibung')).id)")
"$B" click "[data-correction=\"$K4\"] button[title=\"Ablehnen\"]" >/dev/null; sleep 0.3
"$B" fill "[data-correction=\"$K4\"] input[name=rejectReason]" "Text bleibt: der Kunde wird im Beleg genannt." >/dev/null
"$B" js "[...document.querySelectorAll('[data-correction=\"$K4\"] button')].find(b=>b.innerText==='Ablehnen').click(); 'ok'" >/dev/null; sleep 1.5
"$B" click '[data-testid=reviews-merge-all]' >/dev/null; sleep 2
"$B" js "document.querySelector('[data-testid=reviews-message]').innerText" | tee -a "$OUT/run.log"
shot 21-owner-after-merge
"$B" js "[...document.querySelectorAll('[data-correction]')].map(e=>e.dataset.correction+':'+e.dataset.status).join(' ')" | tee -a "$OUT/run.log"
go "$UI/de/2026-Q3/log"; "$B" js "document.querySelector('[data-commit] button').click(); 'ok'" >/dev/null; sleep 0.4; shot 22-owner-protokoll

log "import again: nothing changes"
HEAD_BEFORE=$(git -C "$SB" rev-parse HEAD)
( cd "$REPO" && VANILLA_WORKSPACE="$SB" node --import tsx src/cli/review.ts import "$OUT/review-2026-Q3-anna-muster.json" > "$OUT/review-import-again.txt" )
head -2 "$OUT/review-import-again.txt" | tee -a "$OUT/run.log"
[ "$(git -C "$SB" rev-parse HEAD)" = "$HEAD_BEFORE" ] && echo "  HEAD unchanged" | tee -a "$OUT/run.log"

log "git log --graph of the workspace"
git -C "$SB" log --graph --format='%h %an: %s' | tee "$OUT/git-log-graph.txt" | tee -a "$OUT/run.log"
git -C "$SB" status --short | tee -a "$OUT/run.log"
log "VAT figures: preview against merge"
git -C "$SB" show "$(git -C "$SB" rev-list --max-parents=0 HEAD):books.json" > "$OUT/books-base.json"
( cd "$REPO" && node --import tsx .claude/skills/verify/review-figures.ts "$OUT/books-base.json" "$OUT/review-2026-Q3-anna-muster.json" "$SB/books.json" | tee "$OUT/vat-figures.txt" | tee -a "$OUT/run.log" )
cp "$SB/books.json" "$OUT/books-after.json"; cp -r "$SB/review" "$OUT/workspace-review-dir"
node -e "const a=require('$SB/accounts.json').find(a=>a.number==='6800');console.log('  accounts.json after the merge:', a ? a.number+' '+a.name : 'no 6800')" | tee -a "$OUT/run.log"
"$S" doctor "$RUN" </dev/null > "$OUT/doctor.txt" || true
if grep -q FAIL "$OUT/doctor.txt"; then grep FAIL "$OUT/doctor.txt" | tee -a "$OUT/run.log"; else echo "  doctor: every line ok (real workspace untouched)" | tee -a "$OUT/run.log"; fi
"$B" stop >/dev/null 2>&1 || true
"$S" down "$RUN" >/dev/null
echo "evidence: $OUT"
