# Spec: payroll (Lohnbuchhaltung)

Status: rewritten and decided by the owner 2026-11-19 (§21), after the owner's decision to follow the approach of the Swiss
market leader's payroll module closely: «many in Switzerland are used to that concept». The
concept, flows, terms, data model and phase plan below follow that approach; §20 lists every
decision of the concept of 2026-11-15 that this replaces, and §21 the owner's decisions on it (2026-11-19).
Earlier states: decided by the owner 2026-11-14 (§16), market-review patterns and «warn, then the
person decides» 2026-11-15 (§17, §18), values that change over time the same day (§19). No code
yet. A clickable prototype of the 2026-11-15 concept is in
[mockups/payroll/](mockups/payroll/index.html); §12.3 lists what in it must change.

Builds on [ADR 0011](../adr/0011-payroll.md), which this rewrite **amends** (accepted by the owner
2026-11-19: see the amendment at the end of the ADR and §21), and is judged by
[MISSION.md](../../MISSION.md) and
[ADR 0015](../adr/0015-base-cases-in-the-app-long-tail-in-the-workspace.md).

The owner asked: «and how about Lohnbuchhaltung?». Two levels answer it:

- **Level A**: book payslips that other software or the Treuhänder issues. ADR 0011 step 1
  exists; §10 lists what is still missing.
- **Level B**: payroll in the app. **B0 first**: the owner as the only employee of his own
  one-person GmbH (ADR 0011 step 2). Staff (B1) and Quellensteuer (B2) follow, each after the
  phase before has shipped and a persona round has scored it (§15).

Sections 1 to 3 are findings: what exists, who needs what, what the law requires. Sections 0 and
4 to 15 are the concept. Sections 16 to 19 keep the earlier decisions on record; 20 and 21 are new.

---

## 0. The concept on one page

Swiss payroll software and the fiduciaries who use it share one model. The app takes it, with its
terms, and adds what this app does differently (code first, the AI for judgement, everything by
hand too; nothing filed or closed ever changes).

| Term (UI, de) | What it is | Where |
|---|---|---|
| **Löhne** | the payroll area: Übersicht, Lohnabrechnungen, Lohnzahlungen, Mitarbeitende, Dokumente, Einstellungen | src/app/areas/payroll/ |
| **Stammdaten** (Unternehmen) | the firm's payroll settings: canton of work, payday, posting date, rounding, proration, 13th method, Lohnausweis settings, the sender of payslips | `payroll.json` `company` |
| **Sozialversicherungen** | one section per insurance (AHV/IV/EO/ALV with its Ausgleichskasse, FAK, BVG, UVG, UVGZ, KTG; Quellensteuer per canton): the fund or insurer, member and contract numbers, its **Lösungen** with codes and rates, its liability account | `payroll.json` `insurances` |
| **Lohnart** | every amount on a payslip is a Lohnart: a key, a group, flags (gross or not, adds or deducts, basis for AHV/ALV, UVG, UVGZ, KTG, BVG, QST, the 13th, holiday pay), the Lohnausweis field, a debit and a credit account. The app ships the catalogue; the firm renames, re-accounts and copies | `modules/ch/payroll.yaml` + `payroll.json` `wageTypes` |
| **Mitarbeitende** | one record per person: Person, Kinder, Anstellung, Wiederkehrende Lohnarten, Adresse, Bank, Versicherungen, Abwesenheiten, Quellensteuer; each value dated, shown on a **Zeitachse** | `payroll.json` `employees` |
| **Lohnabrechnung** | the payslip of one person for one month: computed from the values that hold in the month and the recurring Lohnarten, plus the Lohnarten added for this month; **Entwurf** until the person **abschliesst** it; then it is booked and kept | `transactional-data/<year>/payroll/payslips.jsonl` |
| **Lohnlauf** | the month for all Mitarbeitende: «3 von 3 abgeschlossen», the totals, the checks, «Alle abschliessen» | derived |
| **Rückwirkende Korrektur** | a correction entered on a closed Lohnabrechnung (a Lohnart, employee and employer side); the difference is carried to the person's next open Lohnabrechnung as a correction line. The default way to correct | `payslips.jsonl` |
| **Lohnzahlungen** | per month: who gets how much to which IBAN, purpose, value date; status «bezahlt» from the bank statement | derived |
| **Lohnbuchungen** | the entries a closed Lohnabrechnung books, per Lohnart, through the **Lohndurchlaufkonto** | journal, ref `LR-…` |
| **Lohnkonto** | per person and year: every Lohnart summed per month; and the same for the firm | Dokumente |
| **Jahresmeldungen** | AHV-Lohnbescheinigung, AHV-exempt persons, FAK statement, UVG, UVGZ and KTG wage declarations, BVG expected wages | Dokumente |
| **Lohnausweis** | Form 11 per person from the closed Lohnabrechnungen, each Lohnart in its field; a snapshot, replaced or corrected by a new one | Dokumente |

The month, start to end:

```text
Einstellungen (once, dated)          Mitarbeitende (dated, Zeitachse)
  Stammdaten · Sozialversicherungen     Anstellung · Wiederkehrende Lohnarten
  Lohnarten · Konten                     Versicherungen · Bank · Kinder
              \                             /
               v                           v
        Lohnlauf <Monat>: one Lohnabrechnung (Entwurf) per person
          code computes every line: base × rate = amount
          the person adds this month's Lohnarten (hours, bonus, expenses)
          checks as facts; a missing input is a line «unvollständig»
          preview of the bookings
                     |
                     v  «Abschliessen» (per person or «Alle abschliessen»; warns, never blocks)
        Lohnabrechnung abgeschlossen → PDF in Belege, entries booked (D/C per Lohnart via 1091)
                     |
           +---------+------------------------------+
           v                                        v
   Lohnzahlungen: the person pays            Sozialversicherungen: each liability account
   (e-banking; pain.001 later); code         = accrued by payslips − paid; Akonto and
   matches the bank line: D 1091 / C bank    Schlussabrechnung matched by code
                     |
                     v  a mistake found later
        Rückwirkende Korrektur → carried to the next open Lohnabrechnung
        (or «Wieder öffnen»: only the person's latest closed month, only in an open period)
                     |
                     v  year end
        Lohnkonto · Jahresmeldungen · Lohnausweis (PDF + CSV) · 1091 and 227x explained
```

What the app does differently from the market's model, and keeps:

- **Booking is part of closing.** There is no separate monthly «transfer to the ledger» that can be
  forgotten. The preview shows the entries before; closing books them through the write door.
- **Status comes from facts.** «Bezahlt» from the bank statement, the insurers' balances from the
  books, never from a click.
- **Warn, then the person decides** (owner, 2026-11-15). A missing input does not block closing.
  Security boundaries and closed periods stay hard (§18).
- **A closed Lohnabrechnung is never rewritten.** Its history is append-only; a reopening takes
  back its entries and appends; a payslip in a closed period has only the correction (AGENTS.md
  golden rule 1, seals).
- **Setup from the documents.** The AI reads the fund's decision, the certificate, the policy and
  proposes the figures on a card; the person keeps them. Every form works without the AI.
- **No AHV number and no salary to the model** unless code cannot read a document, and then
  masked (#508).

---

## 1. What exists today

### 1.1 The decision

- [docs/adr/0011-payroll.md](../adr/0011-payroll.md), accepted 2026-10-10. Step 1 (book what others
  calculate) exists. Step 2 (the owner-only helper: fixed monthly salary, entered rates, payslip
  PDF, monthly bookings, year totals for «eLohnausweis SSK») is not built. Step 3 (full payroll)
  is «a product of its own, later, or never».
- [docs/getting-started.md](../getting-started.md) § «Payroll»: «It does not calculate payroll, the
  Lohnausweis or the AHV statement».
- The setup's question `employees` (`none` / `owner` / `staff`) in
  [src/workspace/setup.ts](../../src/workspace/setup.ts) states the same limit in its caveat
  (`desktop.q.employees.*.caveat` in src/app/i18n/locales/). `employs(profile)` (setup.ts:320) is
  true for `owner` and `staff`. Nothing else reads the answer.
- [docs/country-checklist.md](../country-checklist.md) `entity.payroll`: «Slot: none … payroll is
  not built».

### 1.2 Accounts and setup data

- [modules/ch/accounts.yaml](../../modules/ch/accounts.yaml): 5000 Lohnaufwand, 5700 AHV/IV/EO/ALV,
  5710 FAK, 5720 BVG, 5730 UVG, 5740 KTG, 5810–5880 other staff costs, 5900 temp staff; 2270
  Sozialversicherungen und Vorsorgeeinrichtungen; **2279 Quellensteuer** (in the chart, but no code
  or guide uses it).
- [modules/ch/setup.yaml](../../modules/ch/setup.yaml) `wages`:
  - `account: "5000"`: the wage account. A rule on it asks for no rate
    ([src/booking/rule-vat.ts](../../src/booking/rule-vat.ts)). The hand form proposes it
    ([src/saving/hand-rule.ts](../../src/saving/hand-rule.ts):277, #382).
  - `deductions: "2270"`: the account that holds what the payslips withheld until the funds are paid.
  - `contributions: [5700, 5710, 5720]`: the employer's contribution accounts. They carry no VAT code.
  - `payees: [ausgleichskasse]`: the only business file that collects the employees' share.
  - `shared: [5700, 5720]`: the contribution accounts the employees share in. FAK (5710) is not
    one of them.
  - `withholds`: the words a payslip names each deduction by, per kind: `ausgleichskasse` (AHV, IV,
    EO, ALV and the fr/it forms), `pension`, `accident`, `sickness`, `tax` (Quellensteuer). Only
    `ausgleichskasse` is keyed to a business file. The other kinds only tell rows apart.
- [modules/ch/year-end.yaml](../../modules/ch/year-end.yaml) template `socialInsurance` (5700 / 2270):
  a blank year-end entry the person fills in by hand.

### 1.3 Processes and knowledge

- [processes/booking.guide.yaml](../../processes/booking.guide.yaml) `cls-salary` (proposed): book the
  gross salary on 5000: the net against the bank, the employee's deductions against 2270, with no
  VAT code. `cls-social-insurance` (proposed) holds the whole #426/#470/#476/#489 contract: the
  employees' share clears 2270, the employer's share goes on 5700/5710/5720/5730/5740, an
  insurer's premium takes I0, and wages booked net leave nothing on 2270.
- [processes/evidence.guide.yaml](../../processes/evidence.guide.yaml) `ev-exempt-wages`
  (`apply: { receipt: none, firm: employer, text: … }`): a wage is booked at once without waiting
  for a receipt, on a firm that `employs()`, recognised by a narrow regex over the payment text
  (#340). The firm condition is read in
  [src/booking/receipt-wait.ts](../../src/booking/receipt-wait.ts):291 (`wages: employs(firm.profile)
  ? receiptWordings(k, 'employer') : []`) and
  [src/booking/classify.ts](../../src/booking/classify.ts):318 (`wageWordings`).
- [processes/authorities/ausgleichskasse.yaml](../../processes/authorities/ausgleichskasse.yaml):
  `match.payee` (cantonal funds' names in de/fr/it), facts `shares` (AHVG Art. 14 Abs. 1), `akonto`
  (AHVV Art. 34/35), `akonto-due`, `salary-report` (AHVV Art. 36, by 30 January), and rule
  `ev-ausgleichskasse-notice` (`apply: { receipt: none, pairs: true }`, #456: the payment needs no
  receipt, but the Akonto bill is still paired with it).
- [processes/year-close.flow.yaml](../../processes/year-close.flow.yaml) `signoff` names the fact
  `ausgleichskasse#salary-report`. No step produces anything for payroll.
  [docs/year-end.md](../year-end.md) lists «Social insurance (5700 / 2270): AHV, BVG and UVG final
  statements against advance payments» as a manual entry.
- No authority file for the pension fund, the UVG insurer or the cantonal tax office as a
  Quellensteuer collector. processes/authorities/steuerverwaltung.yaml covers the direct taxes
  only.

### 1.4 Code

[src/booking/withheld.ts](../../src/booking/withheld.ts) (389 lines, pure, browser-safe):

| Function | What it does | Issue |
|---|---|---|
| `withheldFor` | the credit on 2270 at the end of a payment's day (year opening + entries, without the payment's own) | #426 |
| `wageAccounts` | the setup's `wages` as sets | #426 |
| `paysContributions` | a payment out goes to a `payees` business, or an earlier payment to the same payee was booked on 2270/57xx | #426 |
| `payeeContributionAccount` | the contribution account of the payee's last payment (a pension fund stays on 5720) | #470 |
| `wagesBooked` | the year carries a line on 5000 up to the day. Only then does an empty 2270 mean wages booked net | #470 |
| `overWithheld`, `withinWithheld` | an answer that takes more off 2270 than it holds is capped, and the rest goes to the employer's account | #470 |
| `atWithheld` | an answer's take from 2270 is set to exactly `share`, in either direction | #476 |
| `mergedLines` | one line per account after the moves | #489 |
| `payslipDeductions(text, total, kinds)` | reads a payslip's pdftotext: deduction rows with a minus, per kind; columns laid out label-then-amount or all labels then all amounts (only when rate × gross proves the order); correction rows; refuses prose and compounds («AHV-Nr.», «AHV-pflichtiger Lohn») | #476 |
| `fundShare` | the part of 2270 a payment to a fund clears: what that fund's kinds withheld on the linked payslips, less what earlier payments took, never more than 2270 holds. Undefined unless every wage that put something on 2270 has payslips whose deductions add up | #476 |
| `withheldSharesOf`, `withheldPayeesOf` | the same, per ref, for the task list | #476 |
| `clearingProposal`, `unclearedContributions` | the task «Arbeitnehmeranteil abziehen» / «2270 ausgleichen» on a contribution payment booked without the employees' share | #426, #476 |

Elsewhere:

- [src/booking/classify.ts](../../src/booking/classify.ts) `bookWithheldShares` (:599): when the
  payslips arrive after the statement, it books contribution payments the app already booked again
  to the payslips' share. It stamps `by: { kind: 'code', check: 'withheldShare' }` (books schema 9,
  [src/workspace/schema.ts](../../src/workspace/schema.ts):54). It is called from
  [src/intake/classify.ts](../../src/intake/classify.ts):178 after every run. Lines :1099–:1210
  tell the model what 2270 holds and cap or set its answer.
- [src/llm/prompts.ts](../../src/llm/prompts.ts):232, :425–428: the «Withheld from wages» lines for
  the model.
- [src/saving/wage-rule.ts](../../src/saving/wage-rule.ts): `wageOffer` drafts one text rule for
  ≥ 2 open wages (`WAGES_FROM`) on 5000 without VAT (#383, still open: «four steps and books
  nothing when kept»).
- [src/server/routes/journal.ts](../../src/server/routes/journal.ts):200
  `POST /api/payments/:ref/clear-withheld` with its undo. [src/server/edits.ts](../../src/server/edits.ts):770ff.
- [src/app/areas/automation/WithheldFix.tsx](../../src/app/areas/automation/WithheldFix.tsx),
  `period-issues.ts` kind `withheld`. [src/intake/pair-chain.ts](../../src/intake/pair-chain.ts):152
  (the shares for the task).
- [src/app/areas/automation/period-issues.ts](../../src/app/areas/automation/period-issues.ts) kind
  `issued`: a receipt the firm issued that only waits for its customer. It is
  `waitsForCustomer`, and only when the receipt shows the firm's UID (`issuedByFirm(r) === 'uid'`,
  [src/intake/own-invoice.ts](../../src/intake/own-invoice.ts)). A payslip carries the firm's
  letterhead too. It lands in this list only if it prints the UID and no money in matches it.
  There is no `payslip` document kind: [modules/ch/documents.yaml](../../modules/ch/documents.yaml)
  names «Lohnabrechnung» only as a compound that is no bill title (`notCompound`), and «Lohnsumme»
  as `notTotal`.

### 1.5 Tests and cases

- tests/withheld-426.test.ts (17 tests), withheld-net-470 (9), withheld-fund-476 (12; uses the
  consultancy persona's pdftotext texts), withheld-clear-api-476 (2), withheld-drop-489 (10; a drop
  of payslips for several people and months, the model mocked), number-match-426 (13),
  refused-payment-470 (10). Also receipt-wait.test.ts, hand-form-382, rule-vat-nocode,
  task-names-365, by-hand-without-ai*.
- Casebook ([docs/casebook.md](../casebook.md)) cases 1–4:
  [salary-payment](../../examples/cases/salary-payment.yaml) (owner-employee, D 5000 / C 1020 net + D
  5000 / C 2270 deductions), [ahv-akonto](../../examples/cases/ahv-akonto.yaml),
  [bvg-premium](../../examples/cases/bvg-premium.yaml),
  [accident-sickness-insurance](../../examples/cases/accident-sickness-insurance.yaml).
- Demos: `demo-consulting` (owner, gross 8,600) and `demo-schreinerei` (one employee, gross 6,200)
  book wages gross. The net comes from the bank line (`noReceipt` text) and the deductions from a
  **manual entry** `M2026-0xx` per month
  ([tools/demo/consulting.ts](../../tools/demo/consulting.ts):167ff,
  [tools/demo/schreinerei.ts](../../tools/demo/schreinerei.ts):144ff). The demos carry no payslip PDF.
  `demo` (Kaffee) and `demo-coiffeur` have no wages.

### 1.6 Gaps (level A)

1. **No payslip document kind.** A payslip is a receipt like any other. Its gross, net and
   deductions are read only inside `fundShare`. The wage line itself is booked by the model (in
   withheld-drop-489 the model is mocked to return 5000/2270), never by code, so without an AI a
   wage is booked net or by hand.
2. **The wage's gross booking is the model's.** Code knows the bank's net and, from
   `payslipDeductions`, the deductions. It could book `cls-salary` itself.
3. **Quellensteuer goes nowhere.** The kind `tax` is read, but `cls-salary` puts every deduction on
   2270, and 2279 is unused. No business is keyed to `tax`: a payment to the cantonal tax office
   for withheld tax is not told what was withheld. The Bezugsprovision (the commission the
   employer keeps) has no account or rule.
4. **Only the compensation fund has a share.** `pension`, `accident` and `sickness` have no business
   file (ADR 0015 forbids naming a fund in the app). A pension fund's payment relies on the
   model reading the bill's per-person split.
5. **Family allowances paid with the wage.** A payslip that adds Kinderzulagen (the FAK pays them
   back through the fund's bill) has no rule. The model has to guess.
6. **Year end.** No check that 2270 is explained at 31.12. (Schlussabrechnung against the Akontos),
   no check that 5000 equals the sum of the payslips' gross, no per-employee year totals, no
   Lohnausweis data.
7. **No import of a payroll program's journal.** Payroll programs and the Treuhänder all
   export a «Lohnjournal» or «Buchungsjournal». Today only their PDFs reach the app.
8. **Salary data and the AI.** Payslips go through the model like any receipt (prompts carry their
   text). AHV numbers and salaries reach the model provider. Nothing marks them.
9. **#383** (the wage rule from a task books nothing when kept) and **#359** (without an AI, book
   the bank's fee row and wages by code) are open and touch the same path.

---

## 2. The personas: who employs whom

| Persona / demo | Firm | Who is paid | Needs |
|---|---|---|---|
| Sandra Huber (verify/personas/README.md, persona-files/huber.mjs) | Malerei Huber GmbH, Wil SG, painters | Marco Rossi (employee, net 5,200), Sandra herself (net 4,800). Thomas, the owner, draws no wage in the files | Monthly wages for two people, fixed. A painters' GAV (minimum wage, 13th salary, a branch fund's deduction), canton SG FAK. Today: only the net bank lines and no payslips, so the books show net wages. Her wish «mach die Lohnabrechnung für Marco» (personas/wishes.md §6) gets an honest «kann ich nicht» |
| Corinne Wyss (first-run-webshop.md, persona-files/webshop.mjs) | Teegarten Wyss GmbH, Sursee LU | Corinne (Geschäftsführerin, gross 4,700, BVG from the plan); Jana Imhof (shipping, 40 %, gross 1,550) | Owner plus one part-timer. Jana's 18,600 a year is under the BVG entry threshold (22,680), so no BVG. At 40 % (≥ 8 h/week) she is NBU-insured. Hourly pay with a holiday surcharge is the likely real case for her |
| Matthias Kälin (first-run-consulting.md, persona-files/consulting.mjs) | Kälin Advisory GmbH, Zug | Matthias only (gross 9,500, BVG 290) | Exactly ADR 0011 step 2: one owner-employee, fixed monthly salary, one canton, no Quellensteuer |
| demo-consulting (tools/demo/consulting.ts) | Muster Consulting GmbH | the owner, gross 8,600 | Same as Matthias |
| demo-schreinerei (tools/demo/schreinerei.ts) | Schreinerei Beispiel GmbH, net-rate VAT | Marco Beispiel, gross 6,200 (AHV/IV/EO + ALV only) | One employee. A joiners' GAV applies in reality (13th salary, minimum wages) |
| demo-coiffeur (tools/demo/coiffeur.ts) | Salon Beispiel, Einzelfirma, not VAT-registered | nobody | Nothing. The owner's own AHV as a self-employed person (AHVG Art. 8/9) is not payroll and stays out. If she hires a helper, the simplified procedure (BGSA, §3i) is open to an Einzelfirma and is the smallest possible payroll |
| demo (Kaffee) | Muster Kaffee GmbH | nobody in the books | Nothing |
| Treuhänder (verify/personas/treuhaender.md, docs/personas/treuhaender.md) | many small firms | their clients' staff | Runs payroll elsewhere (certified software, ELM). Needs level A: the journal imported, 2270 reconciled, wages owed at year end |
| Employee (docs/personas/employee.md) | – | – | Gets no clone of the books. With level B: their own payslip and Lohnausweis by mail, nothing more |

What follows:

- Two of three verify personas and both payroll demos are **«owner plus 0–1 people, fixed monthly
  wage, one canton, no Quellensteuer»**. That is ADR 0011 step 2, slightly widened.
- The Treuhänder and every firm that keeps its payroll provider need **level A**. Level B does not
  replace it.
- No persona has a foreign employee taxed at source. Quellensteuer is real for Swiss SMEs
  (cross-border staff, B permits), but no persona tests it today.

---

## 3. Swiss requirements (primary sources)

Figures for 2026. Each item says what changes **yearly (Y)**, **per canton (K)**, **per fund or
insurer (F)**, or **per contract or GAV (G)**. Where only secondary sources were found, this is
said.

### 3a AHV/IV/EO (first pillar)

- Who: employees from 1 January after their 17th birthday (AHVG Art. 3). Employees beyond the
  reference age keep paying, with an allowance (Freibetrag) of CHF 1,400 per month / 16,800 per
  year per employer (AHVV Art. 6quater). Wages up to CHF 2,500 per year per employer are exempt
  unless the employee asks; household and cultural work is always subject (AHVV Art. 34d).
  The reference age is 65; for women it rises in steps under AHV 21 (born 1961: 64 + 3 months,
  later cohorts more).
- What: the «massgebender Lohn» (AHVG Art. 5, AHVV Art. 7, exclusions AHVV Art. 8). It includes the
  13th salary, bonuses, holiday pay and fringe benefits. Family allowances are excluded (AHVV Art. 6
  Abs. 2 lit. f).
- Rates 2026: AHV 8.7 %, IV 1.4 %, EO 0.5 %, total **10.6 %, half each (5.3 %)** (AHVG Art. 5 and
  13, IVG Art. 3, EOG Art. 27 / EOV Art. 36). No ceiling. Sources: BSV «Entwicklung Beitragssätze
  2026»; SVA Zürich Lohndeklaration 2026 (6.4 % AHV/IV/EO/ALV per side). **Y**: the financing of the
  13th AHV pension may change the rates in a later year. Unchanged for 2026.
- Administration costs: per fund, at most 5 % of the contributions (AHVG Art. 69, AHVV Art. 157).
  Employer only. **F**.
- Process: the employer withholds and pays both halves (AHVG Art. 14 Abs. 1, Art. 51). It pays
  Akonto on the expected wage sum, monthly, or quarterly up to a wage sum of 200,000 (AHVV Art. 34,
  35). It sends the annual Lohnbescheinigung by 30 January (AHVV Art. 36), and the fund settles
  the difference. Every employer is affiliated with a cantonal or an association fund (AHVG
  Art. 64). Already in processes/authorities/ausgleichskasse.yaml.

### 3b ALV (unemployment)

- **2.2 %, half each (1.1 %)**, on the wage up to **CHF 148,200 per year** (AVIG Art. 3 Abs. 1–2;
  the maximum insured earnings are those of UVG, UVV Art. 22). Not owed beyond the reference age
  (AVIG Art. 2 Abs. 2).
- **Solidarity percentage:** the extra 1 % (0.5 % each) on wages above 148,200 was **abolished on
  1.1.2023**. 2026 sources show no ALV above the ceiling (SVA Zürich, Solothurn Merkblatt
  Lohnabzüge 2026). The app must not apply it to 2026 wages, but it must know it for a
  correction of a year before 2023. **Y**: rate and ceiling are set by law and ordinance.
- The ceiling is annual and pro rata for part years. Payroll software annualises it per month
  (cumulative): a December bonus can cross it.

### 3c BVG (occupational pension)

- Mandatory from an annual wage above the **entry threshold of CHF 22,680** (BVG Art. 2, Art. 7):
  for death and disability risks from 1 January after the 17th birthday, for old-age savings
  from 1 January after the 24th.
- Insured («koordinierter») wage = AHV wage − **coordination deduction CHF 26,460**, at least
  **3,780**, at most **64,260** (upper limit **90,720**) (BVG Art. 8, BVV 2 Art. 3, 5). Values for
  2026 are unchanged from 2025, because the AHV pension was not adjusted. **Y**: for 2027 the
  Federal Council raised them (entry 23,040, coordination 26,880, per Raiffeisen/WEKA. Check the
  BSV «Masszahlen»).
- Age credits (Altersgutschriften) in % of the insured wage: 25–34: 7, 35–44: 10, 45–54: 15,
  55–65: 18 (BVG Art. 16). The employer pays at least half (BVG Art. 66 Abs. 1).
- In practice the pension fund's plan decides: a lower threshold, a different coordination,
  risk premiums, cost shares. The plan's annual certificate states the employee's and the
  employer's contribution per person. **F**: the app must take the fund's figures, never compute
  the BVG minimum as if it were the plan. The BVG reform was rejected on 22.9.2024, so the law
  above stands.

### 3d UVG (accident) and KTG (sick pay)

- UVG is mandatory for every employee (UVG Art. 1a). BU (occupational accidents) is paid by the
  employer (UVG Art. 91 Abs. 1). NBU (non-occupational) is paid by the employee unless agreed
  otherwise (Art. 91 Abs. 2), and only for employees working at least 8 hours per week for the
  employer (UVG Art. 8 Abs. 2, UVV Art. 13). Insured earnings up to **CHF 148,200** (UVV Art. 22).
  Premium rates are per insurer, risk class and contract (Suva or a private insurer). **F**.
  Supplementary insurance (UVG-Z) is optional.
- KTG (Krankentaggeld) is **voluntary**, under VVG or KVG Art. 67ff. Without it, the employer pays the
  wage for a limited time under OR Art. 324a (the Bern/Basel/Zürich scales). A GAV often makes KTG
  mandatory. **F/G**.

### 3e Family allowances (FAK)

- At least **CHF 215** child allowance and **CHF 268** education allowance per month from 1.1.2026
  (FamZG Art. 5, raised by the Federal Council to follow prices). Cantons pay more (e.g. Geneva;
  figures not verified here). **K/Y**.
- Paid by the employer with the wage and refunded by the family compensation fund. Financed by
  employer contributions at a **cantonal and fund-specific rate** (FamZG Art. 15–16). Some
  cantons (VS) also charge employees. The firm is subject to the FAK of the canton where it has
  its seat or branch (FamZG Art. 12). **K/F**. A claim depends on the other parent's job: the
  person decides and the fund confirms.

### 3f Quellensteuer (withholding tax)

- Who: foreign employees without a C permit resident in Switzerland, and cross-border workers
  and some others resident abroad (DBG Art. 83, 91; StHG Art. 32, 35). Cross-border workers from
  Germany: at most 4.5 % (DBA CH-DE Art. 15a). France, Italy and the cantons have their own
  regimes. **K**.
- How: the employer deducts tax by the **cantonal tariff** of the canton of residence, or of the
  workplace for residents abroad. It uses tariff codes A–H (residents) and L–Q (German
  cross-border), each with a number of children and a church-tax flag (A0N, B1Y, …) (DBG Art. 85,
  QStV SR 642.118.2, cantonal ordinances). It pays the tax to the canton monthly, quarterly or
  as the canton says (DBG Art. 88). It keeps a **Bezugsprovision of 1–2 %** (DBG Art. 88 Abs. 4;
  the canton sets it, **K**). It reports a new employee within 8 days (canton). It annualises
  for irregular pay (QStV Art. 1ff: monthly or annual model by canton).
- Tariffs: the ESTV publishes the 26 cantons' tariff files every year (ZIP/TXT, documented record
  format, 2026 files published 18.12.2025). A canton may correct them during the year (AG corrected
  L/M/N/Q on 4.3.2026). The 2027 files are expected in December 2026. **Y/K**.
- Since the 2021 revision an employee may ask for, or must receive, a subsequent ordinary
  assessment (DBG Art. 89, 99a). The employer's duty stays the withholding.

### 3g Lohnausweis

- The employer issues each employee an annual **Lohnausweis (Form 11)**, also at the end of
  employment (DBG Art. 127 Abs. 1 lit. a; StHG Art. 45 lit. a). It follows the ESTV/SSK
  «Wegleitung zum Ausfüllen des Lohnausweises». Its numbered fields: 1 Lohn, 2 fringe benefits
  (2.1 meals, 2.2 private use of a company car, 2.3 others), 3 irregular pay, 7 other benefits,
  8 gross total, 9 AHV/IV/EO/ALV/NBUV contributions, 10 BVG (10.1 ordinary, 10.2 buy-ins), 11
  net, 12 Quellensteuer withheld, 13 expenses (13.1 effective, 13.2 flat), 15 remarks; boxes F
  (free transport to work) and G (canteen meals). Several cantons (BS, BE, …) want the employer
  to send copies to the tax office. **K**.
- Free federal tool: «eLohnausweis SSK». Payroll software may print Form 11 itself: the Wegleitung
  2026 says the Lohnausweis is as a rule printed straight from payroll software on white paper
  (Rz 75), and the Wegleitung is binding for filling it in (Rz 1). Checked 2026-11-19, §21
  decision 6. Whether the SSK tool reads an import file was not verified; the CSV is the fallback.

### 3h Contract law: 13th salary, holidays, hourly pay, payslip

- Payslip: the employer must give a written statement of the wage and its deductions (OR Art.
  323b Abs. 1). Wages are due at the end of each month (OR Art. 323 Abs. 1).
- 13th salary: owed only by contract or GAV, then pro rata for a part year. A Gratifikation is
  discretionary (OR Art. 322d). **G**.
- Holidays: at least 4 weeks, 5 up to age 20 (OR Art. 329a). They may not be paid out during the
  employment (OR Art. 329d Abs. 2). For irregular hourly work, a holiday surcharge in the hourly
  wage is tolerated if it is shown separately in the contract and on every payslip (BGE 129 III
  493): **4/48 (8.3 %)** for 4 weeks, **5/47 (10.6 %)** for 5, **6/46 (13.0 %)** for 6. Public holidays (and the 1st of
  August) for hourly staff by contract or GAV, typically about +3.6 %. **G**.
- Overtime: OR Art. 321c (+25 % unless agreed otherwise in writing).
- Minimum wages: cantonal laws in **NE, JU, GE, TI, BS** (2026 hourly figures differ between
  secondary sources: GE ≈ 24.6, BS ≈ 22.2, NE ≈ 21.4, JU ≈ 21.4, TI 20–20.5 by branch),
  plus municipal ones (the city of Lucerne from 2026, per secondary sources). Parliament has passed
  a law making declared-binding GAV minimum wages take precedence over cantonal ones. A referendum
  against it was submitted in October 2026. **K/G/Y**, and unsettled. The app can warn, never
  decide: a GAV's minimum by age, training and region is workspace data.

### 3i Simplified procedure (vereinfachtes Abrechnungsverfahren, BGSA)

- For small employers: each wage at most **CHF 22,680** a year and the wage sum at most **60,480**
  (2026, SECO). It is **not open to AG, GmbH or cooperatives**, nor to the employer's spouse or
  children (BGSA Art. 2–3; AHVV Art. 34a; DBG Art. 37a). The compensation fund
  collects AHV/IV/EO/ALV, FAK and a flat Quellensteuer (5 %: 0.5 % federal, 4.5 % cantonal) once a
  year, by 30 January. Since 2025 there is a «plus» variant that includes the UVG premium.
- This is the smallest payroll: the coiffeur who hires a helper. It needs no tariff file and no
  BVG. It is a candidate base case (phase B1, §15).

### 3j ELM / Swissdec

- Swissdec is the standard for electronic wage reporting from payroll software to the
  compensation funds, Suva and insurers, the tax offices (Quellensteuer, Lohnausweis) and the
  FSO. Software must be **certified per standard version**: ELM 5.0 is what insurers accept
  today, ELM 6.0 (with KLE 2.0, EO standard 1.0) opened for certification in **April 2026**, and
  ELM 4.0 is retired in 2026 (swissdec.ch).
- It is **not mandatory** for the employer. Paper, the fund's web portal and eLohnausweis SSK
  remain allowed. Some cantons push electronic Quellensteuer reporting. Check per canton
  (**K**).
- ELM is the authorities' XML interface for wage data. Only certified software may send it. The
  app does not plan it (§14, §16 decision 8): the person uses the fund's portal for the annual
  wage declaration and eLohnausweis SSK for Form 11.
- Public sources name no certification fee. Ask Swissdec.

### 3k Retention and data protection

- Payroll records are business records: kept **10 years** (OR Art. 958f; GeBüV). The AHV fund may
  audit the employer (AHVG Art. 68 ff).
- Salary data are personal data (DSG SR 235.1). Health-related data (sick leave, accident) are
  **especially protected** (DSG Art. 5 lit. c). The employer may process only what concerns the
  employment (OR Art. 328b) and must secure it (DSG Art. 8). The **AHV number** may be used
  systematically only by authorised users, with technical safeguards (AHVG Art. 153b–153i).

### 3l Keeping the figures current

| Figure | Changes | Who sets it | Where it lives (proposal) |
|---|---|---|---|
| AHV/IV/EO and ALV rates, ALV ceiling, AHV Freibetrag, small-wage limit, reference ages | Y | Federal law / ordinance | `modules/ch/payroll/<year>.yaml`, each figure with `source:`, maintained by the app like `rates.yaml` |
| BVG entry threshold, coordination deduction, min/max coordinated wage, age-credit table | Y (every 1–2 years with the AHV pension) | BVV 2 | same file |
| UVG max insured earnings | rarely | UVV Art. 22 | same file |
| Family allowance minimums | Y | FamZG Art. 5 / Federal Council | same file. A cantonal amount and the FAK rate are **company** data |
| VAV limits and flat tax | Y | BGSA / DBG Art. 37a | same file |
| Administration cost, FAK rate, BVG plan, UVG/NBU/KTG premium rates | Y per contract, sometimes mid-year | the firm's fund, insurer, pension fund | the workspace (Sozialversicherungen, §5.2 and §9.2), each a dated entry with the document it is read from (§19) |
| Quellensteuer tariffs | Y, corrections during the year | ESTV / cantons | fetched on demand like `npm run fetch-rates` (src/cli/fetch-estv-rates.ts), into the workspace's `data/` per canton and year, with checksum and source date, never in git |
| Minimum wages, GAV minima, 13th salary, holiday weeks | K/G | canton, GAV | workspace knowledge (`knowledge/rules/payroll.guide.yaml`) and the employment (Anstellung, dated, §19) |

A test (like tests/vat-golden) fails once a year has wages but `modules/ch/payroll/<year>.yaml`
is missing. In December, a task says «Lohnsätze 2027 fehlen in der App» to the developer, not
to the person (no-nagging-reminders: a fact on the payslip, not a reminder).


---

## 4. Goals and non-goals

### Goals

- **G1 (B):** a small firm (the owner first, then up to about ten people, one canton of work) runs
  its monthly payroll in the app the way Swiss payroll software does it: Mitarbeitende,
  Lohnarten, Sozialversicherungen, one Lohnabrechnung per person and month, Lohnzahlungen,
  Lohnbuchungen, the year's documents.
- **G2 (B):** every amount is a Lohnart with base × rate = amount and a source (the federal table,
  the fund's document, the contract), and is a calculation to be checked, not advice (ADR 0011).
- **G3 (B):** the books always show the payroll's state: 1091 the net not yet paid, each
  insurer's liability account what is still owed to it, at any day of the year.
- **G4 (A):** a payslip from any payroll program is booked by code, gross, with its deductions on
  the right accounts, without an AI.
- **G5 (A, B):** the year close proves the payroll: 5000 against the payslips' gross, each liability
  account against the insurers' final statements, the Lohnausweis against the Lohnkonto.
- **G6:** salary data stay inside the workspace. The model never sees an AHV number.
- **G7:** the data model is Swissdec-shaped (member and contract numbers, UVG codes, Lohnart flags,
  the BUR number), so a later certification needs no migration. Certification itself is not a
  goal (§14).

### Non-goals

- Swissdec certification and ELM transmission (§14). Reporting goes by the funds' portals, paper
  and eLohnausweis SSK, with the figures from Dokumente.
- Several cantons of work in one firm (B1 and B2 assume one), staff posted abroad, expatriate rulings,
  share plans, short-time work.
- The owner's own AHV as a self-employed person (Einzelfirma).
- Time tracking. Hours come as a number per month or a CSV, never from a clock-in app.
- HR beyond the wage: contracts, certificates, diagnoses. Abwesenheiten hold only the dates and
  figures the wage needs (§11).
- A branch for one fund, insurer, canton, GAV or payroll vendor in src/ (ADR 0015).

---

## 5. The objects

### 5.1 Stammdaten (Löhne › Einstellungen › Stammdaten)

The firm's payroll settings, each dated where it can change (§19):

| Setting | Values | Default |
|---|---|---|
| Canton of work | one canton (B0, B1) | the firm's seat |
| BUR number | optional (Swissdec-shaped, needed only for statistics or ELM) | – |
| Payday | a day of the month, or «letzter Arbeitstag» | the 25th |
| Posting date of the Lohnbuchungen | the last day of the month, or the payday | the last day of the month |
| Rounding | to 0.05 per line, or to 0.01 (decision 13) | 0.05 |
| Proration inside a month | calendar days, or 30 days | calendar days |
| 13th salary method | 1/12 of the year's wage, or 8 1/3 % | 1/12 |
| Holiday pay basis (hourly) | the hourly wage, or the hourly wage with the holiday surcharge | the hourly wage |
| Lohnausweis settings | meals, free transport (box F), canteen (box G), approved expense rules (canton, date), remarks for field 15 | none |
| Sender of payslips | the firm's mailbox and the person who gets a copy of each mail | the firm's mailbox |

A change of rounding, proration or method never touches a closed Lohnabrechnung (it read the old
value, `used`, §19).

### 5.2 Sozialversicherungen (Löhne › Einstellungen › Sozialversicherungen)

One section per insurance. Each names its fund or insurer by a knowledge file (`business`), the
member and contract numbers, the liability account, and one or more **Lösungen** (a code and its
rates, dated). Several insurers of one kind (two UVG policies) and several solutions per insurer
(«A» office, «B» workshop) are allowed. An insurance a Lohnabrechnung used is never deleted; it can
end (`validUntil`).

| Insurance | Federal (app data, §3l) | The firm's, from its document | Per person |
|---|---|---|---|
| AHV/IV/EO, ALV | rates, ALV ceiling, pensioners' allowance, ages, small-wage limit | the Ausgleichskasse, member number, Verwaltungskosten (Beitragsverfügung) | pensioner: allowance or waiver for the year; «AHV-pflichtig» by age (code) |
| FAK | the minimum allowances | the FAK, canton, rate (decision of the fund) | the children and their allowances (Kinder) |
| BVG | entry threshold, coordination, limits, age credits | the Vorsorgeeinrichtung, contract number, solutions | contributions per month from the certificate (fixed), or a % of the coordinated wage |
| UVG | maximum insured wage | the insurer, customer and contract numbers, solutions A–Z with BU and NBU rates, the employer's share of NBU (0, 50 or 100 %) | the solution code and BU/NBU (A0, A1, A2 in the Swissdec scheme); NBU only from 8 hours a week |
| UVGZ, KTG | – | the insurer, solutions with rates (by sex where the policy states it), minimum and maximum insured wage, the employee's share | the solution code |
| Quellensteuer | the tariff files per canton and year (fetched, §3f) | the cantons with the firm's customer number, the Bezugsprovision | tariff code, canton, municipality, church, other employments (§5.4) |

The Übersicht says as a fact while a section the firm needs is incomplete («UVG: kein NBU-Satz ab
01.01.2027»). Each rate shows its document; the AI reads the document and proposes (§8).

### 5.3 Lohnarten (Löhne › Einstellungen › Lohnarten)

The catalogue in `modules/ch/payroll.yaml` is the app's, as data: the Swiss model of a wage-type
master with the app's own keys. A Lohnart:

```yaml
- key: monatslohn
  group: lohn                      # see the groups below
  label: { de: Monatslohn, fr: Salaire mensuel, it: Salario mensile, en: Monthly salary }
  sign: +                          # adds to the gross (+), deducts (-), or is a total/basis (=)
  gross: true                      # part of the gross wage
  bases: [ahv, alv, uvg, uvgz, ktg, bvg, qst, thirteenth, holiday]   # the bases it counts for
  lohnausweis: "1"                 # the field it is summed into
  debit: "5000"
  credit: "1091"
  computes: { quantity: months, rate: employment.amount }   # how code fills it, or absent: entered
```

The groups, in the order a payslip prints them:

| Group | Examples | Counts for the gross | Typical accounts |
|---|---|---|---|
| Lohn | Monatslohn, Stundenlohn, Taglohn, Lohn bei Krankheit/Unfall, Überstunden, Ferien- und Feiertagsentschädigung | yes | D 5000 / C 1091 |
| Zulagen | Funktions-, Schicht-, Nacht-, Sonntagszulage | yes | D 5000 / C 1091 |
| Einmalige Zahlungen | 13. Monatslohn, Bonus, Gratifikation, Provision, Dienstaltersgeschenk | yes (13th field 1; irregular field 3) | D 5000 / C 1091 |
| Naturalleistungen | Privatanteil Geschäftsfahrzeug (field 2.2), Verpflegung (2.1), Wohnung (2.3) | yes, and taken out again after the deductions (no cash) | D 1091 / C the cost account (car: 6200s) |
| Ersatzleistungen | EO-, UVG-, KTG-Taggeld, Mutterschaft | as the law says per kind (flags) | D 1091 / C the insurer's account, or 5000 |
| Familienzulagen | Kinderzulage, Ausbildungszulage, Geburtszulage | no (AHV), yes (QST) | D the FAK's liability account / C 1091 (decision 10) |
| Abzüge | AHV/IV/EO, ALV, NBU, UVGZ, KTG, BVG, Korrekturen | – (deducted) | D 1091 / C the insurer's liability account |
| Quellensteuer | Quellensteuer, Korrektur | – | D 1091 / C 2279 |
| Spesen | effektiv (field 13.1), pauschal (13.2) | no | D 5820 / 5830 / C 1091 |
| Nettoabzüge | Lohnpfändung, Vorschuss, Rückzahlung, Parifonds | no | D 1091 / C the creditor's account |
| Arbeitgeberbeiträge | AHV/IV/EO, ALV, Verwaltungskosten, FAK, BU, NBU share, UVGZ, KTG, BVG | – (not on the employee's view) | D 57xx / C the insurer's liability account |
| Basen and totals | Bruttolohn, AHV-Lohn, ALV-Lohn, UVG-Lohn, BVG-Lohn, QST-Lohn, Nettolohn, Auszahlung, Feriensaldo | – | none |

Code reads only the flags, never the key: no Swiss name in src/ (the layers lint, tests/layers.test.ts).

What the workspace may do (`payroll.json` `wageTypes`):

- **rename** a Lohnart, change its **accounts** and its **Lohnausweis field**. A field changed
  after payslips closed changes the next Lohnausweis, never a closed payslip;
- **copy** a Lohnart: the copy keeps every flag, takes a new key and label («Nettolohnausgleich»
  as a copy of a negative Lohn line, «Unbezahlter Urlaub»), and can be removed while no closed
  payslip uses it;
- **define** a Lohnart with flags of its own. The form warns first: which rule the flags touch
  and what follows («ohne AHV-Basis: AHV, ALV und Ziffer 1 sind um diesen Betrag zu tief»);
  then «Trotzdem anlegen» (§18). The AI may draft one from a GAV text with the person;
- never **delete** a Lohnart a closed payslip used (record invariant; the AHV audit reaches back
  years).

The «accounts exist» check: every account a used Lohnart books on exists in the chart, else the
Einstellungen show it as a fact with «Konto anlegen» (number and name from the catalogue), like
the provider's clearing account today.

### 5.4 Mitarbeitende

One record per person, every value dated (§19). Sections:

| Section | Holds | Phase |
|---|---|---|
| Person | name, birth date, sex, nationality, residence permit, language (of the payslip), e-mail, AHV number (or «noch unbekannt»), «Inhaber/in» | B0 |
| Anstellung | entry, exit and reason, fixed term or not, monthly or hourly, amount, Pensum, hours per week, holiday days, 13th salary and its payout months | B0 (monthly), B1 (hourly) |
| Wiederkehrende Lohnarten | the Lohnarten every Lohnabrechnung of this person gets, with their values (flat expenses, the company car, a garnishment, a function allowance) | B0 |
| Adresse | the address, the canton and municipality of residence | B0 |
| Bank | IBAN (the payment and its match), the account holder | B0 |
| Versicherungen | BVG solution and contributions (from the certificate), UVG and UVGZ code, KTG code, AHV for pensioners | B0 |
| Kinder | name, birth date, allowance kind and amount as the FAK decided, from and until | B1 |
| Abwesenheiten | from, to, kind (Krankheit, Unfall, Mutterschaft/Vaterschaft, Militär, unbezahlter Urlaub), incapacity %, continued pay %; no diagnosis | B1 |
| Quellensteuer | subject or not, canton, municipality, tariff code, church, other employments (Pensum or income elsewhere, or unknown), working days in Switzerland | data B0, computed B2 |

The **Zeitachse** above the sections shows the person's months: closed ones marked, open ones,
and the dates where a value changes, with «+ Änderung ab» to add one, also inside a month. A
closed month shows the values its Lohnabrechnung used. Changing a value of a closed month opens the
card of §19.3; its first choice is the Rückwirkende Korrektur.

### 5.5 Lohnabrechnung and Lohnlauf

A **Lohnabrechnung** belongs to one person and one month. While it is an **Entwurf** it is
recomputed on every read from the values that hold in the month (§19) and the Lohnarten:

1. the recurring Lohnarten of the person, then the Lohnarten added for this month (hours, a
   bonus, expenses, a text);
2. the gross and the bases, each cumulated over the year where a ceiling needs it (ALV, UVG, the BVG
   upper limit), corrected month by month;
3. the deductions per insurance (base × rate = amount), the Quellensteuer, the net deductions;
4. the net and the payout;
5. the employer contributions (shown with the switch «+ Arbeitgeber»).

Every line is `{ wageType, label, base, rate, amount, side, source }` and prints base × rate =
amount. A line whose input is missing is shown «unvollständig», red, with the field to enter it
(§6.2). Correction lines carried from a closed month show «Korrektur <Monat>» and `corrects`.

The **Lohnlauf** of a month is the view over all its Lohnabrechnungen: one row per person
(gross, deductions, net, employer, status), the totals, the checks, «Alle abschliessen», a text
for every payslip of the month. Its status is «x von y abgeschlossen». It is no object of its own.

### 5.6 Dokumente

| Document | From | Phase |
|---|---|---|
| Lohnabrechnung PDF | each closed payslip, in the person's language | B0 |
| Lohnkonto (per person, per firm) | every Lohnart summed per month and year | B0 |
| Buchungsjournal of a month | the Lohnbuchungen as a CSV (for a fiduciary who keeps the ledger elsewhere) | B0 |
| AHV-Lohnbescheinigung | AHV and ALV wages per person and period | B0 (figures), B1 (with exempt persons) |
| FAK statement | allowances paid against the FAK's refunds | B1 |
| UVG, UVGZ, KTG declarations | the insured wages per solution and code | B0 |
| BVG expected wages | the January wage × 12 per person, for the fund's annual statement | B1 |
| Lohnausweis (Form 11) | the closed payslips by each Lohnart's field, the Stammdaten's Lohnausweis settings; PDF per person and a CSV of every field | B0 |

A generated Lohnausweis is a snapshot: a later change makes a «Lohnausweis ersetzen» (all
persons) or «korrigieren» (some), each kept beside the first.

---

## 6. Flows

### 6.1 Einrichten

1. **Switching on.** The setup's `employees` answer (`owner` or `staff`) shows the Löhne area.
   The Übersicht's empty state says what to do first: «Dokumente der Kassen ablegen oder
   Sozialversicherungen von Hand erfassen».
2. **Documents.** The person drops the Ausgleichskasse's Beitragsverfügung, the BVG certificate,
   the UVG and KTG policies. Code finds what it can read plainly; the AI reads the rest and
   proposes each figure with its document on a card; the person keeps it. Nothing is used before
   she keeps it. Without the AI: the same fields as a form.
3. **Lohnarten and accounts.** The catalogue is there; the check lists missing accounts with
   «Konto anlegen». For B0, the liability accounts 1091 and 2271–2275 are added by the setup
   (§7).
4. **Mitarbeitende.** «Person hinzufügen»; for B0 the owner, with «Inhaber/in». The employment
   contract or the last payslip of the old system may be dropped: the AI proposes Anstellung and
   Versicherungen, the person keeps them.
5. **Opening.** A firm starting mid-year enters the year's totals so far per person (gross, AHV and
   ALV wage, BVG, QST): one opening line per Lohnart group, so the ceilings and the Lohnausweis
   count from January. The opening books nothing: the books already carry those months; it feeds
   only the cumulation of the bases and the Lohnausweis.

### 6.2 The month

1. **The Lohnlauf opens itself.** From the first day of a month, its Lohnabrechnungen are drafts
   for every person with an Anstellung in it. Nothing is created by hand; the Übersicht's year
   strip shows the month as open.
2. **The person adds this month's Lohnarten**: hours for an hourly wage, a bonus, expenses, an
   advance. From the Lohnart list, or by a wish in the sidebar («Bonus 2'000 für Marco im
   Dezember»), which drafts the line for her to keep.
3. **Checks, as facts beside the run**: an entry or exit this month, a value changing inside the
   month (lines split by days), a ceiling reached, the BVG threshold crossed, an age limit (AHV
   from the year after the 17th birthday, ALV ending at the reference age), a wage under a known
   minimum, a missing IBAN, a missing account. None is a reminder; none blocks.
4. **Missing input** is its own line «unvollständig» with the field («Stunden fehlen»,
   «Kaufpreis fehlt»). Code computes no amount for it.
5. **Preview**: below the lines, every entry closing will book (debit, credit, text, amount, the
   posting date, the ref), and the payment D 1091 / C bank to come. The same function previews
   and books.
6. **Abschliessen**, per person or «Alle abschliessen». With a line «unvollständig» the click first
   says what is off, which rule it touches and what follows, then «Trotzdem abschliessen» or
   «Zurück» (§18). Closing:
   - books the entries through the write door (`update(books, PERSON, …)` for the click,
     `by: { kind: 'code', check: 'payroll' }` on each entry, ref `LR-<yyyy>-<mm>-<employeeId>`);
   - writes the payslip PDF into `transactional-data/<year>/receipts/` as a receipt of kind
     `payslip`, linked to the payslip;
   - appends the payslip to `payslips.jsonl` with its lines, bases and `used` (§19).
7. **Months in order.** A person's month closes only after her earlier months of the year are
   closed (the cumulated bases depend on them). A later month's draft shows the fact «Juli noch
   offen» and its figures as provisional.
8. **Sending.** «Per Mail senden» per person or for all closed payslips, from the firm's mailbox,
   to the person's own address, as an encrypted PDF (§11), a copy to the sender of payslips. Each
   recipient is shown before sending. Every mail is in the sending log; a resend too.

### 6.3 Lohnzahlungen

The month's list: person, IBAN, payout, purpose «Lohn <MM/YYYY>», value date (the payday). The
person pays in e-banking. The bank statement brings the line; code matches it by amount and the
person's name or IBAN valid on the payday and books D 1091 / C bank; the list shows «bezahlt» with
the bank line. A payment of several wages in one line is split by the payslips it covers. In B1 the
list writes a pain.001 file through the payments channel the invoicing work builds; until that
channel exists, no file (§21 decision 5).

### 6.4 Sozialversicherungen through the year

- Each closed payslip credits the insurers' liability accounts with both shares (§7).
- An **Akonto** bill and its payment: the payment is booked against the insurer's account only
  (the expense was accrued); the bill is paired with it (`ev-ausgleichskasse-notice`).
- A **Schlussabrechnung**: code reads the fund's total and books its difference to the Akontos
  against the liability account and the expense account of the Lohnart group, once the bill is
  linked: D/C 57xx / C/D 227x.
- The Sozialversicherungen page shows per insurer: accrued by payslips, paid, open, as facts.
- A firm that books an insurer's payment on 57xx by hand after payslips accrued it is warned that
  the share is then expensed twice (one method per year, decision 9) and may keep it (§18).

### 6.5 Corrections

1. **Rückwirkende Korrektur** (the default). On a closed Lohnabrechnung, «Korrektur erfassen»
   takes a Lohnart and an amount, or a base and a rate difference («BVG 7.8 % statt 7.5 % auf
   6'395»), employee and employer side. It is appended to `payslips.jsonl` against the closed
   payslip. The person's next open Lohnabrechnung gets the correction line «Korrektur September:
   BVG» with `corrects: <payslipId>`, and books it when it closes. A negative amount pays back an
   over-deduction. The closed payslip is unchanged; its detail lists the correction and where it
   went.
2. **A correction in the current month** (a missed wage, a late allowance): a Lohnart added to the
   open Lohnabrechnung, with a text.
3. **Wieder öffnen.** Only the person's **latest** closed month, and only while its posting date
   lies in an open period. The click first says what follows, then «Wieder öffnen» or
   «Abbrechen»: its entries are taken back (by ref, through the write door as the person, so a
   person's own change of a payroll entry stays hers), the payslip becomes a draft again with the
   values it used, and the reopening is appended to its history (who, when). Closing again books
   the same refs once and replaces the PDF in Belege; a PDF already sent stays in the sending log. A
   payment already made stays matched; a new net that differs leaves the difference open on 1091,
   shown as a fact. An earlier month cannot be reopened: the card offers the Rückwirkende
   Korrektur.
4. **A closed period.** A payslip whose posting date lies on or before `closedThrough` has no
   «Wieder öffnen», only the Rückwirkende Korrektur (golden rule 1 and the seals; payroll carries
   no VAT, but the books are sealed per quarter).
5. **A change dated back** in the master data: §19.3.

### 6.6 Entry and exit

- **Entry**: the first Anstellung's `validFrom`. A month entered on the 10th prorates by days.
  Mid-year entry: the ceilings prorate (ALV, UVG). Code shows the fact «Neueintritt: Anmeldung
  bei der Ausgleichskasse, der Pensionskasse und dem UVG-Versicherer» on the month, once; no
  reminder afterwards.
- **Exit**: the last Anstellung's `validUntil` and the reason. The 13th is prorated, the holiday
  balance shown, the Lohnausweis of the person is ready when her last payslip closes.
- **A payment after the exit** (a late bonus, holiday paid out): «Nachzahlung» on a person who left
  this or last year opens a Lohnabrechnung for the month with only the added Lohnarten.

### 6.7 Year end and the new year

- The **Lohnausweis** per person once all her payslips of the year are closed (PDF + CSV);
  the **Jahresmeldungen**; the **Lohnkonto**.
- **Checks in Abschluss** (facts, src/app/areas/close/steps.ts): 1091 at 31.12. = the December net
  not yet paid; each liability account = what its insurer still bills; 5000 = Σ gross of the
  closed payslips per person; the Lohnausweis field 8 = Σ gross per person.
- **The new year** needs nothing: dated values continue; a new Beitragsverfügung or certificate is
  a new entry from 1 January. The federal figures of the year come with the app
  (`modules/ch/payroll/<year>.yaml`); while the year's file is missing, a December payslip that
  needs it shows the line «unvollständig: Bundeswerte 2027 fehlen in der App».

---

## 7. Booking

### 7.1 Accounts

The setup adds what payroll needs to the chart (modules/ch/accounts.yaml, src/workspace/scaffold.ts),
once Löhne is switched on:

| Account | Name | Holds |
|---|---|---|
| 1091 | Lohndurchlaufkonto | the net and payout between closing and the bank payment; 0 after the payment. Replaces 2290 of the 2026-11-15 concept |
| 2271 | AHV/IV/EO/ALV (Ausgleichskasse) | both shares and the administration cost, until the fund is paid |
| 2272 | Familienausgleichskasse | the FAK contribution less the allowances paid through the wage |
| 2273 | Unfallversicherung (UVG, UVGZ) | BU, NBU and UVGZ until the insurer is paid |
| 2274 | Krankentaggeldversicherung | KTG until the insurer is paid |
| 2275 | Vorsorgeeinrichtung (BVG) | BVG until the fund is paid |
| 2279 | Quellensteuer | the tax withheld until the canton is paid (exists) |
| 2270 | Sozialversicherungen und Vorsorgeeinrichtungen | level A's collective account (exists, unchanged) |

Numbering decided by the owner (§21 decision 4). Each insurance names its account (§5.2), so a
firm with its own chart maps them.

### 7.2 What a closed Lohnabrechnung books

Every line books its Lohnart's debit and credit on the posting date, one entry per person per
month (ref `LR-<yyyy>-<mm>-<employeeId>`), one line per Lohnart and account (`mergedLines`). The owner
of a one-person GmbH, an invented example (gross 10,000; AHV/IV/EO 5.3 %, ALV 1.1 %, BVG 300 fixed
each side, NBU 1 %, BU 0.1 %, KTG 0.5 % each side, FAK 1.2 %):

| Line | Debit | Credit | Amount |
|---|---|---|---|
| Monatslohn | 5000 | 1091 | 10,000 |
| AHV/IV/EO Arbeitnehmer | 1091 | 2271 | 530 |
| ALV Arbeitnehmer | 1091 | 2271 | 110 |
| BVG Arbeitnehmer | 1091 | 2275 | 300 |
| NBU | 1091 | 2273 | 100 |
| KTG Arbeitnehmer | 1091 | 2274 | 50 |
| AHV/IV/EO, ALV Arbeitgeber | 5700 | 2271 | 640 |
| Verwaltungskosten | 5700 | 2271 | the fund's rate × 1,060 |
| FAK | 5710 | 2272 | 120 |
| BVG Arbeitgeber | 5720 | 2275 | 300 |
| BU | 5730 | 2273 | 10 |
| KTG Arbeitgeber | 5740 | 2274 | 50 |
| *later:* the bank payment of the net, 8,910 | 1091 | 1020 | 8,910 |

After the payment 1091 is 0; 2271 to 2275 hold exactly what each insurer is owed for the month.
No line carries a VAT code (rule-vat: wage accounts ask for no rate).

Lines outside the cash: a **Naturalleistung** (the company car's private share) books D 1091 / C the
car's cost account (it was in the gross and the bases, and is taken out again before the payout);
its VAT as own use is booked by the app's own-use rule (`private: { as: own-use }`), not by
payroll. **Familienzulagen** book D 2272 / C 1091 (the FAK refunds them by netting its bill,
decision 10 on the FAK's own account). **Spesen** D 5820/5830 / C 1091. A **Lohnpfändung** D 1091 /
C the debt collection office's account (a business file), paid from there. A **Vorschuss** D 1xxx
(receivable from the person) / C 1020 when paid, and its repayment D 1091 / C 1xxx.

### 7.3 Level A and B side by side

Level A (payslips issued elsewhere) keeps booking the net against the bank and the deductions on
2270, as today (`withheld.ts`). A firm moving from A to B mid-year moves to the per-insurer
accounts from its first closed payslip; the year-close check reads both (2270 and 2271–2275). Code
never books an insurer's share twice: a contribution payment for a month whose payslips accrued
it books against the liability account only.

---

## 8. Who decides what, and where it lives

### 8.1 Code, the AI, the person

| Task | Code | AI | Person |
|---|---|---|---|
| Federal rates, thresholds, ceilings (cumulated), ages, pro rata, rounding | ✓ from `modules/ch/payroll/<year>.yaml` | – | overrides a line with a reason, kept on the payslip |
| The firm's rates (Verwaltungskosten, FAK, BVG, UVG, UVGZ, KTG) | checks plausibility (range per kind in the module) | reads the document she drops and proposes each figure with it | keeps it on a card; nothing used before |
| Mitarbeitende (Anstellung, Versicherungen, Kinder) | validates (minimum wage known as data, BVG threshold, NBU from 8 hours) | reads a contract or an old payslip and proposes | enters or keeps |
| Lohnarten | ships the catalogue; checks accounts | drafts a GAV's Lohnart or rule into the workspace with her | renames, re-accounts, copies, keeps |
| The month | computes every draft, the checks, the preview, books at close, matches the payment | explains a figure when asked («wieso isch de Lohn tüüfer?») from the lines | adds this month's Lohnarten, closes |
| Corrections | carries a Rückwirkende Korrektur to the next month; takes back a reopened month's entries | – | enters the correction, or reopens the latest month |
| Quellensteuer tariff code (B2) | looks up the amount in the canton's file | – | enters the code from the person's declaration |
| Documents | computes them from closed payslips | – | generates, sends, submits by the fund's channel |

Everything an AI row does has a form. B0 and B1 work entirely without an AI. Payroll never calls the
model on its own: the AI is asked only on her drop or her question.

### 8.2 App and workspace (ADR 0015)

| In the app | In the workspace |
|---|---|
| The payroll engine (src/payroll/): Lohnarten by flags, bases, cumulation, proration, closing, corrections, reopening, preview = booking | The firm's Stammdaten, Sozialversicherungen with their documents, Mitarbeitende (`payroll.json`) |
| `modules/ch/payroll.yaml`: the Lohnart catalogue (keys, groups, flags, Lohnausweis fields, default accounts, labels de/fr/it/en), insurance kinds and their legal splits, plausibility ranges, proration and rounding choices | The firm's Lohnart overrides and copies; a GAV's Lohnarten and rules (`knowledge/rules/payroll.guide.yaml`), written by the AI with the person |
| `modules/ch/payroll/<year>.yaml`: the federal figures with sources | A canton's allowance above the minimum (the FAK's decision), the firm's insurers as business files |
| The tariff-file fetch and lookup (a documented public format, B2) | Which cantons, the persons' codes |
| Invariants: closed payslips append-only, closed periods, the write door, seals; no AHV number to a model | A fund's portal and its upload format (a source the AI writes, ADR 0014) |
| Payslip, Lohnkonto and Lohnausweis PDF layouts (one base layout, like src/invoices/pdf.ts) | The letterhead (the invoice layout's logo) |
| The base errors: missing rate, missing input, a ceiling, the BVG threshold, a missing account or IBAN | – |

No branch for one fund, insurer, canton, GAV or payroll vendor in src/.

---

## 9. Data model

### 9.1 Books (ledger, `BOOKS_SCHEMA` 9, src/workspace/schema.ts)

- `JournalEntry.by.check` gains `'payroll'` (B), `'payslip'` (A3) and `'payrollJournal'` (A6):
  **books schema 11** (10 went to the payables' due date, #571), one empty migration step for all three, with the first phase that books one
  (B0; decision 5).
- Refs `LR-<yyyy>-<mm>-<employeeId>` (a closed payslip; a correction books under the payslip that
  carries it) and `LJ-…` (a payroll journal import). Check `transactionRef` consumers that assume a
  bank ref or `M`/`RE`/`GS`.
- Accounts of §7.1 in modules/ch/accounts.yaml.

### 9.2 `payroll.json` (`PAYROLL_SCHEMA = 1`)

Beside `invoices.json` (LAYOUT top, owner `app`), its own schema and ladder in
src/workspace/schema.ts; the manifest is unchanged (decision 6).

```ts
// Dated<T>: docs/specs/domain-model.md §5.2 (validFrom, validUntil?, value, enteredAt, source?).
interface PayrollStore {
  schema: 1;
  company: {                                   // Stammdaten (§5.1)
    canton: Dated<string>; bur?: string;
    payday: Dated<number | 'last-working-day'>;
    postingDate: Dated<'month-end' | 'payday'>;
    rounding: Dated<0.05 | 0.01>; proration: Dated<'calendar-days' | 'thirty-days'>;
    thirteenth: Dated<'twelfth' | 'percent'>; holidayBasis: Dated<'wage' | 'wage-with-surcharge'>;
    lohnausweis: Dated<{ meals?: 'free' | 'reduced'; transportF?: boolean; canteenG?: boolean;
                         expenseRules?: { canton: string; approvedOn: string }; remarks?: string }>;
    sender?: { copyTo: string };
  };
  insurances: Array<{                          // Sozialversicherungen (§5.2)
    id: string; kind: string;                  // a kind of modules/ch/payroll.yaml (no Swiss name in code)
    business: string;                          // knowledge file id of the fund or insurer
    memberNumber?: string; contractNumber?: string;
    account: string;                           // its liability account
    solutions: Array<{ code: string; label?: string;
                       rates: Dated<Record<string, number>> }>;   // e.g. { bu, nbu, nbuEmployerShare } in %
    validFrom: string; validUntil?: string;
  }>;
  wageTypes: Array<                            // the workspace layer over the catalogue (§5.3)
    | { key: string; label?: Labels; debit?: string; credit?: string; lohnausweis?: string }  // an override
    | { key: string; copyOf: string; label: Labels; debit?: string; credit?: string }         // a copy
    | { key: string; own: WageTypeDef }>;                                                     // own flags, after the warning
  employees: Array<{                           // Mitarbeitende (§5.4)
    id: string; isOwner?: true; language: 'de' | 'fr' | 'it' | 'en';
    ahvNumber?: string;                        // AHVN13; masked in lists, never to a model, never a password
    birthDate: string; sex?: 'f' | 'm'; nationality?: string;
    name: Dated<string>; permit?: Dated<string>; email?: Dated<string>;
    address: Dated<Address & { canton: string; municipality?: string }>;
    bank: Dated<{ iban: string; holder?: string }>;
    // entry = the first entry's validFrom; exit = the last one's validUntil (+ exitReason)
    employment: Dated<{ kind: 'monthly' | 'hourly'; amount: number; pensum?: number; hoursPerWeek?: number;
                        holidayDays: number; thirteenth?: { months: number[] }; fixedTerm?: boolean;
                        exitReason?: string }>;
    recurring: Array<{ wageType: string; value: Dated<{ amount?: number; base?: number; rate?: number }> }>;
    insurances: Dated<{ bvg?: { insurance: string; solution: string;
                                employee: number; employer: number } | { insurance: string; solution: string; percent: number };
                        uvg?: { insurance: string; code: string };     // e.g. A1
                        uvgz?: { insurance: string; code: string }; ktg?: { insurance: string; code: string };
                        pensioner?: 'allowance' | 'waiver' }>;
    children?: Array<{ name: string; birthDate: string;
                       allowance: Dated<{ kind: 'child' | 'education' | 'birth'; amount: number }> }>;   // B1
    absences?: Array<{ from: string; to: string; kind: string; incapacity?: number; continuedPay?: number }>; // B1, no diagnosis
    taxAtSource?: Dated<{ canton: string; municipality: string; code: string; church: boolean;
                          otherEmployment?: { pensum?: number; income?: number } | 'unknown';
                          daysInSwitzerland?: number }>;  // data from B0, computed in B2
  }>;
}
```

### 9.3 `transactional-data/<year>/payroll/payslips.jsonl`

Append-only, one line per event; the last `close` of an id is the payslip, the earlier lines its
history:

```ts
type PayslipEvent =
  | { event: 'close'; id: string /* <yyyy>-<mm>-<employeeId> */; employee: string; month: 'YYYY-MM';
      postingDate: string; payday: string; closedAt: string; closedBy: 'person';
      lines: Array<{ wageType: string; label: string; quantity?: number; base?: number; rate?: number;
                     amount: number; side: 'employee' | 'employer'; source: string;
                     days?: { from: string; to: string }; corrects?: string }>;
      bases: Record<string, { month: number; year: number }>;   // AHV-, ALV-, UVG-, BVG-, QST-Lohn, cumulated
      gross: number; net: number; payout: number; text?: string;
      left: Array<{ wageType: string; missing: string }>;      // lines «unvollständig» at close: a fact, no flag
      receiptId: string; entries: string[];
      used: Array<{ path: string; validFrom: string; enteredAt: string }> }  // every dated value read
  | { event: 'reopen'; id: string; at: string; by: 'person' }
  | { event: 'correction'; of: string; wageType: string; side: 'employee' | 'employer';
      amount: number; base?: number; rateDiff?: number; text?: string; at: string; by: 'person' };
```

Where a correction went is derived (the next close of that person whose lines carry `corrects`).
LAYOUT (src/workspace/workspace.ts) gains `top['payroll.json']` and `year['payroll']`; `npm run
doctor` names them.

### 9.4 Module data (no schema step)

- `modules/ch/payroll.yaml`: the Lohnart catalogue, the insurance kinds and their legal splits, the
  bases each kind applies to, the Lohnausweis fields, labels de/fr/it/en, plausibility ranges, the
  proration and rounding choices.
- `modules/ch/payroll/<year>.yaml`: the federal figures of §3l, each `{ value, source, validFrom }`,
  read by the same `valueOn` as the firm's values.
- src/core/modules/schema.ts: the types of both. `modules/ch/module.yaml` `provides:
  accounting.payroll.runs@1`.

---

## 10. Level A: booking payslips from external payroll

### 10.1 User stories

- *Treuhänder:* «I drop my client's Lohnjournal CSV of the month. Every wage and every deduction
  is booked, and 2270/2279 show what is still owed to whom.»
- *Corinne (webshop):* «I drop the two payslips and the bank statement. The wages are booked gross
  without me answering anything. The Akonto clears exactly what was withheld.»
- *Matthias (consulting):* «Without an AI subscription my salary is still booked gross.»
- *Sandra (painter):* she has only net bank lines. The app books them net (the accepted variant b
  of kit.mjs) and says once, as a fact: «Löhne netto gebucht: ohne Lohnabrechnungen stimmen
  Lohnaufwand und Lohnausweis nicht überein.»

### 10.2 Changes

| # | Change | Who decides | Files |
|---|---|---|---|
| A1 | **Document kind `payslip`.** Recognised by code: the firm is the issuer (`issuedByFirm` ≠ false), the head names a payslip word (a new `documents.yaml` list `payslip: [Lohnabrechnung, Lohnblatt, Salärabrechnung, Gehaltsabrechnung, Décompte de salaire, Bulletin de salaire, Conteggio salario, Busta paga, Payslip]`) and `payslipDeductions` reads. A payslip is never an «own invoice» waiting for its customer (`waitsForCustomer`) and never a bill. | code | modules/ch/documents.yaml, src/intake/document-kind.ts, src/intake/own-invoice.ts, period-issues.ts |
| A2 | **`readPayslip(text)` → `{ employee, period, gross, net, deductions: Map<kind, amount>, allowances, expenses }`**, built on `payslipDeductions`. It needs gross − Σ deductions + allowances + expenses = net to the Rappen, else undefined. The words for gross, net, allowance and expenses come from `setup.yaml wages.payslip` (data, de/fr/it/en), never from code. | code | src/booking/withheld.ts (or a new src/booking/payslip.ts), modules/ch/setup.yaml |
| A3 | **Code books `cls-salary`.** A wage payment linked to a payslip that reads, with net = the bank amount: D 5000 / C bank (net); D 5000 / C 2270 for the social deductions; D 5000 / C 2279 for kind `tax`; an allowance D 2270 / C bank (the fund refunds it on its bill; §16, decision 10; level B books it on the FAK’s own account, §7.2); expenses D 5820/5830 / C bank. `by: { kind: 'code', check: 'payslip' }`. A payment of several wages (one bank line, several payslips) books each payslip as its own lines. The model is not asked. Without a payslip, the payment is booked net as today (ev-exempt-wages), and when a payslip comes later, code books it again (as `bookWithheldShares` does, never a person's booking). | code | src/booking/classify.ts, processes/booking.guide.yaml cls-salary (→ status: accepted), **books schema step** for the new check (§9.1) |
| A4 | **Quellensteuer as a kind with a payee.** `setup.yaml wages.withholdsTo: { tax: "2279" }` (per-kind deductions account; 2270 stays the default). A business file whose `collects: [tax]` names the cantonal tax office routes its payment to clear 2279. The Bezugsprovision (payment < 2279's share) books C 3xxx/6xxx «Bezugsprovision Quellensteuer» (account in setup.yaml). | code; the person names the tax office's file once | modules/ch/setup.yaml, processes/authorities/steuerverwaltung.yaml (fact `withholding`, DBG Art. 88), src/booking/withheld.ts `fundShare` per account |
| A5 | **Generic payees for pension, accident, sickness.** A business file may say `collects: [pension]` (a contract, not a name). The app's `wages.payees` becomes «ausgleichskasse **plus** every file that declares `collects`». The workspace grows the fund's file. The AI drafts it from the first bill, and the person keeps it on its card. `fundShare` then works for the pension fund too. | code + AI drafts + person keeps | src/knowledge/ (file schema), src/booking/withheld.ts, processes/README.md |
| A6 | **Payroll journal import.** A payroll program's CSV export, recognised by the columns a business file names (`payroll: { reports: { journal: { columns: … } } }`, exactly like `provider.reports.sales` in src/booking/sales-report.ts). It is booked as entries per employee and month by ref `LJ-<business>-<period>-<employee>`, once. The person names the program's file. The app ships the contract and one reference file in tests, no vendor (ADR 0015 row 4). | code (contract), AI writes the column map with the person | src/intake/ (new payroll-journal-import.ts), src/booking/ |
| A7 | **Year-close checks (facts, not reminders):** (a) 5000 of the year = Σ gross of the year's payslips, per employee; difference named. (b) 2270 at 31.12. = Σ what the funds still bill, per kind (from `fundShare`'s arithmetic). (c) The final statement of the fund (Schlussabrechnung) is booked: its difference to the Akontos on 5700 against 2270, proposed by code from the statement's total and the Akontos booked (the `socialInsurance` template becomes a proposal). (d) Per-employee year totals in Lohnausweis fields 1, 8, 9, 10.1, 11, 12, 13 from the payslips read, shown on a «Lohnausweis-Daten» page and exported as CSV for the person or the Treuhänder. | code | src/accounting/year-close.ts, src/app/areas/close/steps.ts, modules/ch/year-end.yaml, processes/year-close.flow.yaml (new step `payroll-check`) |
| A8 | **Salary data marked as such.** A receipt of kind `payslip` is sent to the model only when code cannot read it, and then without its AHV number (a 756.xxxx.xxxx.xx pattern masked before the call, and never in a model prompt). The AI's facts name totals, not persons' wages, unless the person asks about one. | code | src/llm/prompts.ts, src/intake/ (a mask step), docs/0.4.0/ privacy note |
| A9 | Close #383 and #359 on the way: the wage rule books when kept, and code books wages without an AI. | code | src/saving/wage-rule.ts |

### 10.3 Data

- No new store. `Receipt` gains `kind: 'payslip'` if the receipt kinds are typed (check
  src/types/index.ts). Its read figures are derived on every read (as `order-pages.ts` is,
  #253), not stored, so a better reader re-reads old payslips.
- JournalEntry `by.check` gains `'payslip'` and `'payrollJournal'`. That is a **books schema step
  (10 → 11)** with an empty migration, like schema 9 for `withheldShare`. Decided: one step for all
  three checks (§16, decision 5).
- Business files gain `collects: [<kind>]` and `payroll.reports.journal`. That is a knowledge-file
  schema change (src/knowledge/), not a books or manifest step.

### 10.4 Acceptance (persona walk, level A)

Scored on the first-run walks (first-run.md checkpoints), with the AI **off** for one run:

1. Webshop: the six payslips of Q3 and the camt.053 are dropped. All six wages are booked gross by
   code (`by.check: payslip`), 2270 credit after the wages = Σ deductions. The Akonto payment
   clears exactly the AHV/IV/EO/ALV share (as withheld-fund-476 asserts), and the pension fund's
   payment clears the BVG share once its file has `collects: [pension]`. 2270 is 0.00 at 30.09.
   whenever the funds billed the quarter.
2. Consulting: the same with one person. With the AI off, the three wages are still gross.
3. Huber: net bank lines only. Wages net, no payment on 2270, the one fact shown. No question
   asked.
4. Treuhänder: a synthetic Lohnjournal CSV of 3 people × 3 months is booked once. A second drop
   books nothing. «Rückgängig» takes only its entries.
5. Year close on demo-consulting: the A7 checks show 0 differences. Breaking one payslip by
   CHF 10 shows exactly that difference on that employee.

---

## 11. Security and privacy of salary data

The workspace is a git repository (ADR 0013): whoever opens it sees every payslip. Acceptable for
an owner who keeps the books alone; said plainly in setup once a firm has staff («Wer die
Buchhaltung öffnet, sieht die Löhne»). Decision 4 stands: plain, versioned, no encryption of the
store.

- **The model.** No AHV number in any prompt: masked by pattern (756.xxxx.xxxx.xx) before every
  call, tested (#508). Payroll never calls the model on its own; reading a document is the person's
  explicit drop. The AI's facts name payroll totals, not persons' wages, unless the person asks.
- **The AHV number** is used only for social insurance (AHVG Art. 153c): on the payslip, the
  Lohnausweis and the declarations. Never as a password, a file name or a key.
- **Payslips by mail** go only to the person's own address, from the firm's mailbox, as an
  encrypted PDF. The password is set per person by the employer or generated and shown once;
  never the AHV number, and the date of birth only if the employer chooses it after a warning that
  others know it. Each recipient is shown before a send to several.
- **Wage payments in the bank view.** Later, when the app has roles (sharing, ADR 0016), a
  person without the payroll right sees a wage line as «Lohnzahlung» without name and amount
  detail. Not built now: today there are no roles.
- **The public repo.** Fixtures use invented people only. check-public (src/publish/leak-guard.ts)
  treats `payroll.json` and `payroll/` like `receipts/`: company files, never in public-files.txt.
- **Exports.** The audit export includes payroll for the auditor. A Treuhänder export may leave out
  AHV numbers on request.
- **Health data** (DSG Art. 5 lit. c). Abwesenheiten hold dates, kind, incapacity and continued
  pay only; no diagnosis, no doctor's note. A daily allowance is a Lohnart line.
- **Retention.** Payroll records are kept 10 years (OR Art. 958f); a Lohnart used in a closed payslip
  is never deleted; the payslip history is append-only.

---

## 12. UI

### 12.1 The Löhne area

src/app/areas/payroll/, registered in src/app/areas/index.ts, list + detail per the shell
(docs/redesign/architecture.md). Shown when `employs(profile)` (B) or payslips exist (A: the
Lohnausweis data alone). Tabs:

| Tab | List | Detail |
|---|---|---|
| **Übersicht** | the year strip: twelve months, closed / open / to come, today marked, the gross per month; the facts (incomplete Sozialversicherungen, a missing account, a month not closed) | the selected month's Lohnlauf |
| **Lohnabrechnungen** | the month's persons: gross, deductions, net, employer, status; «Alle abschliessen»; a text for every payslip | one Lohnabrechnung: the lines (base × rate = amount) in their groups, «+ Arbeitgeber», a line «unvollständig» with its field, «Lohnart hinzufügen», the preview «Bucht beim Abschliessen», «Abschliessen», later «Korrektur erfassen», «Wieder öffnen» (latest month only), the history, the PDF |
| **Lohnzahlungen** | the month: person, IBAN, payout, purpose, value date, «bezahlt» with its bank line | the bank line and the entries |
| **Mitarbeitende** | persons with Pensum, wage «ab», status (aktiv, ausgetreten) | the Zeitachse and the sections of §5.4, each value with «ab TT.MM.JJJJ», «Verlauf» and «Ändern» («gilt ab») |
| **Dokumente** | the documents of §5.6 per year | the document, PDF and CSV, «Lohnausweis ersetzen/korrigieren» |
| **Einstellungen** | Stammdaten, Sozialversicherungen, Lohnarten, Konten | each section with its dated values and documents |

URLs (docs/urls.md, built by `hrefOf`): `/payroll?period=2026-Q3`, `/payroll/<yyyy-mm>?period=…`,
`/payroll/<yyyy-mm>/<employeeId>`, `/payroll/payments/<yyyy-mm>`, `/payroll/employees/<id>`,
`/payroll/documents/<year>`, `/payroll/settings/<section>`. Firma › Löhne links to Einstellungen.

Elsewhere: a wage entry in Journal links to its Lohnabrechnung; an insurer's payment in Bank shows
«aufgelaufen … bezahlt … offen …»; Abschluss holds the checks of §6.7; the sidebar takes wishes
(«mach d Lohnabrechnig für Marco» opens his draft; «Marco verdient ab September 5'400» drafts a
dated Anstellung entry on a card; «Bonus 2'000 im Dezember» drafts the line).

Colours and classes per UI theming (tokens.css); a line «unvollständig» in `var(--neg)`. The
payslip, Lohnkonto and Lohnausweis sheets keep paper colours, like the invoice sheet. Warnings are
panels in the page, not modal dialogs.

### 12.2 i18n

- Every UI text through `t()`, de first, fr/it/en matching (docs/i18n.md, tests/i18n.test.ts). Key
  groups `payroll.*`, `payroll.settings.*`, `close.payroll.*`.
- Documents (payslip, Lohnkonto, Lohnausweis) print in the person's language; their labels come
  from `modules/ch/payroll.yaml` (Lohnart labels de/fr/it/en), not from the UI dictionaries.
- Limits named when hit: «10 Personen pro Lohnlauf in dieser Version: 2 weitere nicht berechnet» if
  B1 caps them.

### 12.3 The prototype

[mockups/payroll/](mockups/payroll/index.html) shows the 2026-11-15 concept. Updating it is a
larger job than this rewrite (sixteen pages built from the app's DOM); it is listed here for the
B0 build instead:

| Page | Must change |
|---|---|
| index.html | the area's tabs (Übersicht, Lohnabrechnungen, Lohnzahlungen, Mitarbeitende, Dokumente, Einstellungen) and the step list |
| 1-einrichten.html («Firma › Löhne») | becomes Einstellungen › Sozialversicherungen (one section per insurance with Lösungen and codes, liability accounts), plus Stammdaten and Lohnarten pages |
| 1b-ohne-ki.html | the same sections as forms |
| 1c-person.html | the Zeitachse above the sections Person, Anstellung, Wiederkehrende Lohnarten, Adresse, Bank, Versicherungen (B1: Kinder, Abwesenheiten, Quellensteuer); the backdated-change card's first choice «Rückwirkende Korrektur» |
| 2-lauf.html | per-person «Abschliessen» and «Alle abschliessen», «x von y abgeschlossen», «Lohnart hinzufügen» by group, «Wieder öffnen» only on the latest closed month |
| 3-lohnabrechnung.html, lohnabrechnung-*.html | lines grouped by Lohnart group; the correction lines «Korrektur <Monat>» |
| 4-buchungen.html | entries per Lohnart through 1091; liability accounts 2271–2275 instead of 2270 and 2290; posting date = month end |
| 5-zahlung.html | the Lohnzahlungen list with purpose and value date; D 1091 / C bank |
| 6-kassen.html, 6a, 6b, akontorechnung | per insurer account instead of 2270 «je Kasse» |
| 7-jahr.html, lohnausweis-*.csv | Dokumente: Lohnkonto, Jahresmeldungen, Lohnausweis PDF beside the CSV |

---

## 13. Tests and golden-master impact

- **VAT golden master** (tests/vat-golden.test.ts): payroll lines carry no VAT code; no Ziffer
  moves. tests/golden/demo-consulting/ and demo-schreinerei/ books change once the demo generator
  books its wages through payslips (refs, `by`, accounts 1091 and 2271–2275 instead of manual entries
  `M2026-0xx` on 2270); `npm run test:update`, reviewed by the owner as a books change, not a
  «⚠ figures» change.
- **Golden payroll set** `tests/golden/payroll/` (hand-worked, to the Rappen, like
  tests/firm-types.test.ts):
  - B0: the owner, gross 10,000, the figures of §7.2 (invented rates), net 8,910; the same with
    the 13th paid in December; a raise from 16 May (two lines split by days); a backdated BVG rate
    after September closed: the Rückwirkende Korrektur in October equals the difference to the Rappen;
  - B1: part-time 1,550 (no BVG: annual below the threshold, the reason shown); hourly 70 h with the
    4/48 surcharge on its own line; a December bonus crossing the ALV ceiling (cumulated); turning 65
    mid-year (allowance, no ALV from the month after); turning 18; an exit on 15 March (13th and BVG
    prorated); a wage under 2,500 a year; a child allowance through D 2272;
  - B2: one tariff code per canton file version, against the ESTV file; the 30-day extrapolation for
    an entry on the 15th.
- **Property tests**: net = Σ gross Lohnarten − Σ deductions + Σ outside-gross Lohnarten; the
  preview of a draft = the entries its close books; 1091 = 0 after the payments; each liability
  account = accrued − paid; Σ closed payslips = the Lohnkonto = the Lohnausweis field by field; a
  closed payslip is never changed (its `close` line byte for byte after any later event).
- **Corrections and reopening**: a correction on a closed month lands once in the next open month;
  reopening the latest month takes back exactly its entries and closing again books the same refs
  once; reopening an earlier month is refused with the correction offered; a payslip in a closed
  period has no reopening (tests/period-lock.test.ts rows for every new writing route:
  `POST /api/payroll/payslips/:id/close`, `…/reopen`, `…/corrections`).
- **Warnings, not blocks**: a payslip with a line «unvollständig» closes after the warning, the line
  left out of every figure and listed in `left`; no flag (tests assert the absence).
- **Lohnarten**: the catalogue loads; a copy keeps every flag; a Lohnart used in a closed payslip
  cannot be deleted; an own Lohnart is saved after the warning; no Swiss name in src/payroll
  (tests/layers.test.ts).
- **Privacy**: no `756.` pattern in any captured prompt; the AHV number never in a file name or a PDF
  password.
- **Level A**: as in §10.4.
- **Persona walks**: first-run-consulting (B0), first-run-webshop (B1), the Huber wish
  («mach d Lohnabrechnig für Marco») from «honest no» to «carried out» with B1.

---

## 14. Swissdec certification: effort and risk

- **What it takes:** implementing the ELM data model (XML) and its transmission (web services
  with certificates, via the Swissdec distributor), passing Swissdec's test cases for the
  standard version, and certifying per release. ELM 6.0 opened in April 2026, and ELM 4.0 is
  being retired. That is a moving target with a multi-year cycle. Certification also implies
  supporting the full domain (all of §3, several cantons, Quellensteuer for all 26 tariffs),
  because the test cases cover it.
- **Effort:** not quantified from public sources. Judging by the domain alone (B0–B2 plus the
  ELM data model, the transmission and the test cases), it is several person-months up front
  and recurring work for every standard release, plus fees Swissdec does not publish.
- **Risk:** liability toward employees and authorities (ADR 0011). A product commitment no small
  team can drop once firms rely on it. Competition with more than a hundred certified programs.
  It is not mandatory for the employer (§3j), so the benefit to the target group is small.
- **Recommendation:** do not certify. Level A covers firms with certified software. Level B
  delivers paper/PDF outputs and the figures for the funds' portals and eLohnausweis SSK.
  Revisit only if B1 has many firms asking for ELM.

The market leader's payroll is certified, and its annual and monthly reports go out by ELM. This
concept keeps the recommendation above (§21 decision 2) and keeps the data Swissdec-shaped (member
and contract numbers per insurer, UVG solution codes, the BUR number, Lohnart flags and Lohnausweis
fields), so that a later certification needs no migration of the books or of `payroll.json`. The
list of data a declaration still lacks («Mitgliednummer der Ausgleichskasse fehlt») is shown as a
fact in Einstellungen, as the market's monthly-report screen does.

---

## 15. Phased plan

The order stays the owner's of 2026-11-14 (decisions 1 and 2): **B0 first**, for his own one-person
GmbH that runs its payroll itself. Each phase ends with a scored persona walk (first-run.md style),
run twice: AI on and AI off. A phase **passes** when every K.O. checkpoint passes and the points
reach the bar. The next phase starts only after its predecessor passed and shipped.

| Phase | Content | Rough effort |
|---|---|---|
| **B0** | The owner as the only employee of a GmbH or AG: Stammdaten, Sozialversicherungen from the funds' documents (AHV/IV/EO/ALV, FAK, BVG fixed from the certificate, UVG, optional KTG), the Lohnart catalogue (the whole catalogue loaded; B0 uses the monthly wage, 13th, bonus, the company car, flat and effective expenses, the deductions and employer shares), one Mitarbeitende record with Zeitachse, the monthly Lohnabrechnung, closing with preview and booking via 1091 and 2271–2275, the Rückwirkende Korrektur, reopening the latest month, Lohnzahlungen with the bank match, the insurers' accounts with Akonto and Schlussabrechnung, the payslip PDF and its encrypted mail, Lohnkonto, the AHV and UVG/KTG declaration figures, the Lohnausweis PDF and CSV. Quellensteuer: the section exists, a QST-subject person's line is «unvollständig». From level A: the document kind `payslip` (A1) and AHV-number masking (A8). Books schema 11. `payroll.json`, `payslips.jsonl`, `modules/ch/payroll{,/2026}.yaml` | 5–7 weeks |
| **A-2** | Payslips a Treuhänder or a program issues: A2 `readPayslip`, A3 booking by code, A4 Quellensteuer on 2279, A5 `collects:`, A9 (#383, #359) | 3–4 weeks |
| **B1** | Staff: up to ~10 persons, one canton of work; hourly wage with holiday and public-holiday surcharge, holiday balance; 13th with payout months and pro rata; entry and exit mid-month, Nachzahlung; Kinder and Familienzulagen; Abwesenheiten with daily allowances; thresholds and age rules for everyone; FAK statement, BVG expected wages, AHV-exempt persons; pain.001 from Lohnzahlungen once the payments channel exists; the simplified procedure (VAV) for an Einzelfirma | 6–10 weeks |
| **A-3** | A7 year-close checks for external payslips and their Lohnausweis CSV; A6 payroll journal import | 2–3 weeks |
| **B2** | Quellensteuer computed: tariff files per canton and year, the monthly or annual model by canton, rate-determining income (other employments, entry and exit extrapolated to 30 days), Bezugsprovision, the canton's settlement list, corrections. Planned after B1 and built only after B1 (§21 decision 1); its liability line stays in the ADR 0011 amendment | 4–8 weeks for the first canton, then data |
| B3 | Treuhänder: several firms from one desk; an export for ELM-capable software | open, not planned |

### 15.1 B0 acceptance (consulting walk: the owner-employee; demo-consulting)

| # | Checkpoint | K.O. | Points |
|---|---|---|---|
| 1 | Sozialversicherungen set up from the four documents in under 5 minutes (AI on: proposals kept on cards; AI off: forms, under 15 minutes) | | 10 |
| 2 | The accounts check lists 1091 and 2271–2275 and adds them with one click each, or the setup did | | 5 |
| 3 | The September Lohnabrechnung equals the golden case to the Rappen, every line base × rate = amount with its source | K.O. | 15 |
| 4 | The preview lists exactly the entries closing books (same function), refs `LR-2026-09-<id>`, posting date 30.09. | K.O. | 10 |
| 5 | The bank's net is matched by code and 1091 is 0 at the end of the month | | 10 |
| 6 | After the quarter's Akonto bills and payments each liability account holds what the payslips accrued less what was paid; the Schlussabrechnung's difference is booked by code | | 10 |
| 7 | A line «unvollständig» (the company car without a price): the warning names the rule and what follows; «Trotzdem abschliessen» closes; the payslip carries no flag, `left` lists the line | | 5 |
| 8 | A Rückwirkende Korrektur on August (BVG rate) appears in October's draft as «Korrektur August» with `corrects`, to the Rappen | | 10 |
| 9 | «Wieder öffnen» on the latest closed month: entries taken back, closing again books the same refs once; on an earlier month refused with the correction offered; on a month in a closed quarter not offered | K.O. | 10 |
| 10 | Lohnausweis PDF and CSV: each field = Σ of the closed payslips; the Lohnkonto agrees | | 10 |
| 11 | The payslip mail goes to the person's own address as an encrypted PDF whose password is not the AHV number; a copy to the sender | | 5 |
| 12 | No `756.` pattern in any prompt captured during the walk | K.O. | – |

Bar: all K.O. and at least 85 of 100 points, in both runs (AI on, AI off; in the AI-off run
checkpoint 1 counts with the forms).

### 15.2 A-2 acceptance (webshop and consulting walks with external payslips, AI off)

| # | Checkpoint | K.O. | Points |
|---|---|---|---|
| 1 | Six payslips of Q3 and the camt.053 dropped: every wage booked gross by code (`by.check: payslip`) | K.O. | 30 |
| 2 | The Akonto clears exactly the AHV/IV/EO/ALV share (withheld-fund-476); the pension fund's payment clears the BVG share once its file has `collects: [pension]` | | 25 |
| 3 | A payslip with Quellensteuer books 2279 | | 15 |
| 4 | Huber: net bank lines only, booked net, one fact shown, no question asked | | 15 |
| 5 | withheld-*.test.ts stay green; no `756.` in any prompt | K.O. | 15 |

Bar: all K.O. and at least 80.

### 15.3 B1 acceptance (webshop walk: Corinne and Jana; Huber walk: Sandra and Marco)

| # | Checkpoint | K.O. | Points |
|---|---|---|---|
| 1 | Jana's hourly payslip: 70 h × rate, the 4/48 surcharge on its own line, no BVG with the reason «unter der Eintrittsschwelle» | K.O. | 20 |
| 2 | «mach d Lohnabrechnig für Marco» opens his draft with July's recurring Lohnarten and asks only what changed; closing books it | | 15 |
| 3 | The golden payroll set (B1 cases) green | K.O. | 20 |
| 4 | An exit on 15 March: 13th and BVG prorated, the Lohnausweis ready with the last payslip | | 10 |
| 5 | A child allowance books D 2272 / C 1091 and the FAK statement agrees with 2272 | | 10 |
| 6 | Lohnausweis field 8 = Σ gross for each person; the AHV-Lohnbescheinigung's AHV and ALV wages agree with the Lohnkonten | K.O. | 15 |
| 7 | A pain.001 file from the month's Lohnzahlungen, if the payments channel exists; else the list without file and the bank match | | 10 |

Bar: all K.O. and at least 85.

### 15.4 A-3 and B2 acceptance

- **A-3**: a synthetic payroll journal CSV (3 persons × 3 months) is booked once, a second drop books
  nothing, «Rückgängig» takes only its entries (K.O.); the year close of demo-consulting shows 0
  differences and a payslip broken by CHF 10 shows exactly that on that person (K.O.). Bar: both.
- **B2** (a new persona: a cross-border employee from DE, tariff code from the declaration): the
  deduction equals the canton's tariff file for each code of the golden set (K.O.); a tariff
  correction during the year leaves closed payslips unchanged and carries the difference as a
  Rückwirkende Korrektur by the person's click (K.O.); the settlement list per canton equals 2279's
  movements (K.O.). Bar: all three.

The efforts are one developer's estimates with agents doing the programming, before review and
persona rounds.

---

## 16. The owner's decisions (2026-11-14), on record

Kept as decided. Decisions 3, 6, 8, 10, 11 and 12 are replaced by the rewrite of 2026-11-19: §20
says how. The section numbers inside refer to the spec of 2026-11-15.

1. **Order: B0 first, not A.** The owner's own firm is a one-person GmbH that runs its payroll
   itself, without a payroll provider and without a Treuhänder doing the payroll. The app must
   work for that firm first. So B0 comes first: the owner as the only employee of a GmbH, the wage
   set from the fund's certificates, a monthly run, the payslip PDF, the bookings, the payment
   match, 2270 reconciled, the year totals. From A-1, B0 takes only what it needs: the payslip
   document kind and booking the gross wage by code, without an AI. Then A-2 (external payslips:
   Quellensteuer on 2279, pension and accident clearing) for firms whose Treuhänder issues the
   payslips. Then B1 (staff). Why: most small Swiss firms have a Treuhänder or their accounting
   software run payroll, or the owner does it himself. A dedicated payroll provider is rare for a
   micro firm.
2. **First persona: consulting** (Matthias Kälin, owner-employee; demo-consulting for the
   prototype and the golden case). The webshop (Corinne and Jana) follows with B1.
3. **ADR 0011:** amended for B1 only after B0 has shipped and a persona round has scored it. B2
   (Quellensteuer computed) and ELM stay out until a firm asks. The liability argument of
   ADR 0011 still holds for Quellensteuer.
4. **Salary data: in the workspace, plain, versioned. No encryption.** Wages are not hidden from
   the accountant or the Treuhänder: the net shows in every bank line, and the accountant needs
   the gross anyway. Privacy is about two things: (1) the AI model, which never receives an AHV
   number (#508); (2) colleagues, once a firm has staff: setup says plainly that whoever opens
   the books sees the wages.
5. **Books schema 10** for `by.check: 'payslip' | 'payrollJournal' | 'payroll'`: one step for all
   three, with the first phase that books one (B0).
6. **`payroll.json`** with its own schema, like invoices.json. Not a manifest section.
7. **Federal rates maintained by the app, company rates from documents**, as ADR 0011 says.
   `modules/ch/payroll/<year>.yaml` with sources. A test fails when the next year's file is
   missing once a run is dated in it.
8. **Lohnausweis: field-by-field data first.** B0 shows the year totals per Form 11 field and
   exports them as CSV. A Form 11 PDF comes with B1, once it is verified that software-printed
   forms are accepted under the current Wegleitung. The government's XML interface is Swissdec
   ELM, which only certified software may send. It is not planned (§11). Without it the person
   uses the compensation fund's portal for the annual wage declaration and eLohnausweis SSK for
   Form 11. Whether SSK imports a file is verified before B0's year-end step is built.
9. **The employer's contributions are accrued in each run** (B: monthly expense, 2270 matches the
   funds). Level A stays as it is. Code never expenses a share twice when a firm switches
   mid-year (since 2026-11-15: a person's own booking on 57xx is warned, not refused, §15).
10. **Family allowances paid through the wage: D 2270**, with a precedent in booking.guide.yaml.
    A firm rule can override.
11. **No payment file (pain.001) in payroll.** If the invoicing or payments spec builds a pain.001
    channel, payroll hands it the net amounts. Until then the person pays in e-banking, and code
    matches the bank line to the run.
12. **New account 2290 «Lohnverbindlichkeiten»** in modules/ch/accounts.yaml for B's net between
    release and payment. Level A keeps booking the net against the bank.
13. **Rounding to 0.05 per line**, as data in `modules/ch/payroll.yaml`, so a firm can switch it.
14. **The disclaimer** «Berechnung aus den erfassten Sätzen, vom Treuhänder zu prüfen» stands on
    the run's detail and in the payslip's footer in small print, never as a dialog.


---

## 17. Patterns taken from the market review (2026-11-15), on record

Kept as approved; patterns 3 and 5 are replaced by the rewrite of 2026-11-19 (§20). The section
numbers inside refer to the spec of 2026-11-15.

A review of a Swiss market leader's payroll module found five patterns that the owner approved for
this spec and its prototype on 2026-11-15. Patterns only: no names, screens or wording copied.

1. **Base × rate = amount on every line** (§6.5 step 1), with a switch to show the employer's share
   beside the employee's. The auditor and the employee see where each franc comes from.
2. **A missing input is its own line**, red, «unvollständig» (§6.5 step 2). A warning, not a
   block: the run can be released after it (§6.5 step 4).
3. **Extras in two groups named by their effect**: «Zählt zum Bruttolohn (AHV-pflichtig)» and
   «Ausserhalb des Bruttolohns» (expenses, advance, garnishment). The group says what the line
   does to AHV and the Lohnausweis; the person need not know the kind's code.
4. **The bookings before the release** (§6.5 step 3): a preview of every entry, not only the
   journal after.
5. **«Wieder öffnen» for a released run** (§6.5 step 6) with a plain warning of what follows.
   This replaces «a released run is never changed» for open periods. Closed periods keep the
   correction run (step 7).

What the app keeps from its own design where that product leans on manual status: the run's state,
the payment match and the funds' balances on 2270 are set by code from the books and the bank
statement (§6.5 steps 4 and 5), never by a person ticking «bezahlt».

---

## 18. Warn, then the person decides (owner, 2026-11-15; updated 2026-11-19)

Wherever this spec would stop a person, the app says what is off, which rule it touches and what
follows, and offers «Trotzdem …». The action is recorded like any other (who, when, in the
payslip's history or the journal); there is no override flag and no «despite the warning» mark.

| Where | The market's way | Here |
|---|---|---|
| A line without its input (hours, a price, a rate, a tariff code, a tariff file) | closing is blocked | the line is «unvollständig»; «Trotzdem abschliessen» after the warning (§6.2) |
| A closed Lohnabrechnung with a mistake | correction in the next month; reopening discouraged | the same: the Rückwirkende Korrektur first; «Wieder öffnen» for the latest month in an open period (§6.5) |
| A Lohnart with flags of its own | not allowed | allowed after the warning naming the rule (§5.3) |
| An insurer's employer share booked by hand on 57xx after payslips accrued it | – | warning of double expense; the person may keep it (§6.4) |
| A wage under a known minimum (canton, GAV) | – | a warning |
| A change dated before a closed month (§19) | edits in closed months refused | the card of §19.3; its first choice is the Rückwirkende Korrektur |
| A month closed before an earlier one | – | a fact on the later month; its figures provisional until the earlier one closes (the cumulation needs it) |

Not covered, by the owner's exception for security boundaries and by golden rule 1:

- **Security boundaries stay hard:** no AHV number to any model or as a password; payslips only to
  the person's own address; a closed payslip's history never rewritten; a Lohnart a closed
  payslip used never deleted.
- **Closed periods:** a payslip whose posting date lies in a closed period is never reopened; only
  the correction in the next open month (AGENTS.md golden rule 1, `closedThrough`, seals).

---

## 19. Values that change over time (owner, 2026-11-15)

The owner asked: «are we also taking change into consideration? all of those fees and everything,
they can be changed, right? So a Lohn can be changed, a Beitrag can be changed». Yes. Payroll follows
docs/specs/domain-model.md §5: every value a payslip reads is a dated history (`Dated<T>`:
`validFrom`, optional `validUntil`, never overwritten), and a closed payslip keeps the entries it
used. The Zeitachse (§5.4) is how a person sees them.

### 19.1 What is dated

| Value | Typical change | Its entry |
|---|---|---|
| Anstellung: monthly or hourly, amount, Pensum, 13th, holiday days | a raise from January; 80 % from 1 May | `employment` |
| Entry and exit | a start on 1 March, an exit on 15 September | the first entry's `validFrom`, the last one's `validUntil` |
| Wiederkehrende Lohnarten | a flat expense from April; a garnishment until paid | `recurring[].value` |
| Versicherungen of a person (BVG contributions, UVG code) | a new certificate after a raise or a plan change | `insurances`, from the certificate's date, its receipt as source |
| An insurance's rates (Verwaltungskosten, FAK, UVG, UVGZ, KTG) | a new decision or policy year | `insurances[].solutions[].rates` |
| Kinder and allowances | from the month after birth; ending at 16 or with education | `children[].allowance` |
| Address, bank, name, permit, e-mail | a move, a new bank, a marriage | each its own history; the payslip prints the address valid on the payday; code matches the net by the IBAN valid on it |
| Stammdaten (canton, payday, posting date, rounding, proration, methods) | rarely | `company.*` |
| Federal figures | each year, sometimes mid-year | `modules/ch/payroll/<year>.yaml` rows with `validFrom` |

### 19.2 How a payslip reads them

- A draft reads the values that hold in its month. A value changing inside the month splits the
  line by days (`days`), by calendar days or 30 days (Stammdaten). A part without a value is a line
  «unvollständig».
- A planned entry shows before it applies («ab 01.01.2027: 9'000, geplant»); the December payslip
  does not read it, January's does.
- Closing keeps `used`: every dated entry read, by `(path, validFrom, enteredAt)`. A later entry
  never changes a closed payslip.

### 19.3 A change dated before a closed month

When a person (or the AI on her wish) adds an entry whose days a closed payslip covers, code
recomputes that payslip with it and compares. Nothing differs (a new address after the payday): it
saves. A figure differs: the card says so first:

> **September abgeschlossen mit 7.5 %; ab 01.09.2026 gilt jetzt 7.8 %.**
> BVG Arbeitnehmerbeitrag September (Lukas Beispiel): 7.8 % statt 7.5 % auf dem versicherten
> Lohn von 6'395, also rund 499 statt 480 Franken, Differenz rund 19.
> Regel: eine abgeschlossene Lohnabrechnung bleibt, wie sie ist; korrigiert wird im nächsten
> offenen Monat.

The ways on:

- **«Rückwirkende Korrektur»** (first, the default): the difference as a correction line in the
  person's next open Lohnabrechnung, with `corrects` (§6.5 step 1). Several months (a raise dated
  three months back) are listed on one card, and one click corrects them all; each month's
  difference is its own line («Nachzahlung Juli», «Nachzahlung August»).
- **«Wieder öffnen»**: only when the latest closed month is the only one affected and its period
  is open (§6.5 step 3).
- **«So lassen»**: the entry is kept; the payslip shows the fact «berechnet mit 7.5 %; seit
  15.11.2026 gilt für September 7.8 %» in its margin, the choice stays there for later. No reminder.

A closed period offers only the correction. Each choice is recorded in the payslip's history.

### 19.4 Data and tests

`payroll.json` starts at `PAYROLL_SCHEMA = 1` with the histories, so there is no migration. Tests:
`valueOn` at the edges (the day before, on and after `validFrom`/`validUntil`; two entries of the
same `validFrom`); a closed payslip unchanged after a later entry (its `close` line and `used` byte
for byte); the split by days; the backdated change's correction to the Rappen; a withdrawn planned
entry no payslip used; the refusal to withdraw one a payslip used.

---

## 20. Changes from the concept of 2026-11-15 (owner, 2026-11-19)

The owner decided on 2026-11-19 that payroll follows the Swiss market leader's approach closely. What
that replaced, decision by decision:

| Was (2026-11-14/15; numbers of that spec: its §13 is now §16, §14 is §17, §15 is §18, §16 is §19) | Now (2026-11-19) | Why |
|---|---|---|
| §13.3: ADR 0011 amended only after B0 ships; B2 and ELM out «until a firm asks» | The amendment is written now (accepted 2026-11-19, at the end of ADR 0011): full payroll for small firms in phases, B2 planned after B1. ELM still out | The market's approach is a full payroll module; the concept has to describe it whole. The owner accepted the amendment (§21 decision 1) |
| §13.6: `payroll.json` with `plan` (funds, pension, accident, sickness, vav) and per-employee `contract`, `pension`, `allowances`; runs in `runs.jsonl` | `payroll.json` with `company` (Stammdaten), `insurances` (Sozialversicherungen with Lösungen), `wageTypes`, `employees` (sections of §5.4); `payslips.jsonl` per person and month | The market's objects and Swissdec's shape (member numbers, solution codes) |
| §13.8: Lohnausweis as field data and CSV in B0, the Form 11 PDF in B1 | The Form 11 PDF in B0 with the CSV, each field from the Lohnarten's field; replacement and correction as new snapshots | The market prints it from the payslips; the owner needs it in January anyway. The Wegleitung allows software-printed forms (§21 decision 6) |
| §13.10: family allowances paid through the wage: D 2270 | D 2272 (the FAK's own liability account) / C 1091 | One liability account per insurer |
| §13.11: no payment file in payroll | The Lohnzahlungen list in B0 (IBAN, payout, purpose, value date, status from the bank); pain.001 in B1 through the payments channel | The market pays wages from the payroll module; we keep the status from the bank statement |
| §13.12: new account 2290 Lohnverbindlichkeiten for the net | 1091 Lohndurchlaufkonto: every Lohnart books against it; the payment clears it | The Swiss payroll convention: one clearing account, 0 after the payment |
| §6.5 step 4 (2026-11-15): one entry set per person on 5000/2290/2270/2279 | Each Lohnart books its own debit and credit; per-insurer liability accounts 2271–2275 and 2279 | The Lohnart carries its accounts; the balance sheet shows what each insurer is owed |
| §6.5 step 4: posting on the payday | Posting date per Stammdaten, default the month's last day | The market's default; payday stays a choice |
| §6.1/§6.5: one run per month for everyone, released at once («Freigeben») | One Lohnabrechnung per person and month, «Abschliessen» per person or «Alle abschliessen»; the Lohnlauf is the month's view («x von y abgeschlossen») | The market's unit; a late person does not hold back the others |
| §14.3: lines in two groups named by their effect | Lines in the Lohnart groups of §5.3; whether a line counts for the gross and the bases follows from its Lohnart's flags | The Lohnart is the market's core concept; the two buckets are its consequence |
| §14.5, §6.5 step 6: «Wieder öffnen» for any released run of an open period | The Rückwirkende Korrektur is the default; «Wieder öffnen» only for the person's latest closed month, in an open period | The market discourages reopening and allows only the latest month; a closed period keeps only the correction (golden rule 1) |
| §6.5 step 7: a correction run in the next open month for a closed period | Correction lines in the person's next open Lohnabrechnung, `corrects: <payslipId>` | Same effect, the market's shape: no correction object of its own |
| §16.3: choices «Wieder öffnen», «Differenz im nächsten Lauf», «So lassen» | «Rückwirkende Korrektur» (first), «Wieder öffnen» (latest month only), «So lassen» | Follows the correction rule above |
| §9: area «Löhne» with runs and employees; setup in Firma › Löhne | Area «Löhne» with Übersicht (year strip), Lohnabrechnungen, Lohnzahlungen, Mitarbeitende (Zeitachse), Dokumente, Einstellungen (Stammdaten, Sozialversicherungen, Lohnarten, Konten) | The market's layout of a payroll module, as tabs of our area |
| §3l/§7.3: «kinds» of contribution in `modules/ch/payroll.yaml` | A Lohnart catalogue (keys, groups, flags, Lohnausweis field, default accounts, labels) plus insurance kinds | Lohnarten are how Swiss payroll and its fiduciaries think |
| Terms: Person, Lauf, Freigeben, freigegeben, Plan, Kasse | Mitarbeitende, Lohnlauf, Abschliessen, abgeschlossen, Sozialversicherungen, Versicherung/Lösung | Swiss-standard payroll terms |
| §8: payslips by mail as plain PDF | encrypted PDF, password per person, never the AHV number | The market encrypts; we keep the AHV number for social insurance only |
| §4 non-goal «HR: absences» | Abwesenheiten in B1 with dates, kind, incapacity and continued pay only | Wages during illness and daily allowances need them |

Kept unchanged: B0 first and the consulting persona (decisions 1, 2); salary data plain in the
workspace (4); books schema 10 (5); federal rates by the app, the firm's from documents (7); employer
contributions accrued at closing (9); rounding as data (13); the disclaimer (14); base × rate =
amount, the line «unvollständig», the preview, status from facts (§14.1, 14.2, 14.4, last paragraph);
warn, then decide (§15, now §18); dated values (§16, now §19); level A (§10).

---

## 21. The owner's decisions (2026-11-19)

The owner decided the six open questions of this rewrite on 2026-11-19, each as recommended:

1. **ADR 0011: the amendment is accepted.** Payroll for small firms is built in phases B0 → B1 → B2.
   B2 (Quellensteuer computed) starts only after B1 has shipped and passed; it keeps the liability
   line of the amendment (its own golden set per canton tariff file).
2. **ELM/Swissdec stays out.** The data stay Swissdec-shaped (member and contract numbers, UVG
   solution codes, BUR number, Lohnart flags and fields), so the question can be asked again
   without a migration (§14).
3. **The hard lock holds for payroll.** A closed Lohnabrechnung whose posting date lies in a closed
   (filed) period is never rewritten or reopened; it is corrected in the person's next open month
   (Rückwirkende Korrektur, §6.5). Payroll carries no VAT, but the books are sealed per quarter
   (AGENTS.md golden rule 1, `closedThrough`, seals).
4. **Accounts as proposed:** 1091 Lohndurchlaufkonto; 2271 AHV/IV/EO/ALV, 2272 FAK, 2273 UVG/UVGZ,
   2274 KTG, 2275 BVG; 2279 Quellensteuer; 2270 stays level A's collective account (§7.1).
5. **pain.001 in B1**, built in payroll unless the invoicing work has built a payment channel by
   then, in which case payroll hands its Lohnzahlungen to that channel (§6.3).
6. **Lohnausweis PDF in B0, the CSV as fallback.** Checked against the primary source before
   deciding: the *Wegleitung zum Ausfüllen des Lohnausweises bzw. der Rentenbescheinigung
   (Formular 11)*, SSK/ESTV, valid from 1 January 2026
   ([estv.admin.ch](https://www.estv.admin.ch/dam/de/sd-web/afP1GDFr8gE3/dbst-form-lohna-wegleitung-2026-de.pdf)):
   - Rz 75: «In der Regel wird der Lohnausweis direkt aus einer Lohnsoftwareapplikation auf
     weisses Papier gedruckt.» The printed form is ordered only where that is not possible. So a
     software-printed Form 11 is the normal case, not an exception.
   - Rz 1: the form to use is Formular 11, and «für das Ausfüllen des Formulars ist diese Wegleitung
     verbindlich». The app prints Form 11's layout and fields (letters A–I, Ziffern 1–15), filled as
     the Wegleitung says; no form of its own.
   - Rz 12 (Buchstabe I): place and date, the employer's exact address, the person responsible and
     a phone number; signed, but «bei vollautomatisiert erstellten Lohnausweisen kann auf die
     Unterschrift verzichtet werden».
   - Rz 11 (Buchstabe H): the employee's full current address; the address field fits window
     envelopes left or right, and no confidential data may show in the window.
   - Rz 74: BS, BE, FR, JU, NE, SO, VD and VS want a copy sent by the employer to the cantonal tax
     office (LU voluntary): the Dokumente page names this as a fact for the firm's canton.
   - Rz 6: the 13-digit AHV number goes in its field (Buchstabe C): the one place besides the
     payslip and the declarations where the app prints it (§11).

   Not found in the Wegleitung: any certification, barcode or approval requirement for software
   that prints the form. The SSK FAQ (linked from the Wegleitung's «Allgemeines») is to be read
   when the PDF layout is built, for layout details. If the PDF falls short, B0 delivers the CSV for
   eLohnausweis SSK.

---

## 22. Decisions taken while building (delegated by the owner, 2026-11-19)

The owner delegated the build's open questions to the main session on 2026-11-19: decide along this
spec, MISSION.md and ADR 0015, and where the spec is silent, follow the market's approach (§0). Each
non-obvious decision is recorded here when it is taken.

1. **The social security number is `socialSecurityNumber` in `payroll.json`**, not `ahvNumber`: src/
   names no Swiss specific (the layers lint); the UI and the documents call it «AHV-Nummer».
2. **The payroll accounts of §7.1 carry `payroll: true` in modules/ch/accounts.yaml**: a new chart has
   them only when the setup's answer `employees` is `owner` or `staff`; any other firm adds them from
   Löhne › Einstellungen › Konten. A firm without wages keeps the chart it had.
3. **The Lohnarten a person adds to a month not yet closed live in `payroll.json` `monthLines`**; the
   closed payslip keeps its own copy of every line (§9.3), so `monthLines` of a closed month is history
   only.
4. **Benefits in kind (`cash: false`) book wage against the cost they relieve** (company car: D 5000 /
   C 6200) and do not move 1091: they count in the gross, the bases and the Lohnausweis, but no money is
   paid, so 1091 still ends at the payout. The market books the same pair in two Lohnarten through 1091;
   one line is simpler and gives the same balances. §7.2's «D 1091 / C the car's cost account» alone would
   leave 1091 off by the share.
5. **Large figures of modules/ch/payroll/<year>.yaml are written in exponent form** (`148.2e3`), as
   registration.yaml does: the leak guard reads YAML as prose and flags a six-digit number.
6. **The 13th: «1/12» is exactly a twelfth, «8,33 %» is that percentage** of the base since the last payout,
   as the market's two choices; December always pays what the year owes, and so does the last month of a
   person who leaves.
7. **The reference age needs the person's sex**: without it no pensioner rule applies and the payslip
   says «Geschlecht fehlt» as a fact; the app never assumes one.
8. **Recurring Lohnarten are prorated to the days employed**, like the monthly wage (an entry on the 16th
   gets half the flat expenses).
9. **The BVG entry threshold is read against the yearly wage the Anstellung promises** (monthly × 12,
   with the 13th), not against one month annualised, so a bonus month does not cross it.
10. **A hand-over and a share carry `payroll.json` and `payroll/`**: the fiduciary needs them, and the
    books' payroll entries would otherwise arrive without their payslips.
11. **The AI sidebar never reads payroll files** (`payroll.json`, `payroll/`, the payslip PDFs): a deny
    rule of its tools, tested; the terminal agents' instructions say the same.
12. **A Rückwirkende Korrektur entered on a month that is reopened afterwards is void** once that month
    closes again: the new close is computed with today's values, so carrying the old difference would
    count it twice. The reopening card names such corrections.
13. **A month closes after a warning even while an earlier month of the person is open** (§18 over §6.2
    step 7, warn, then the person decides): its cumulated ceilings and the 13th are computed from the
    months closed by then and stay as closed; the warning says so.
14. **The payslip PDF is drawn with pdf-lib and a standard font**, not printed by a browser like the
    invoice: it needs no Chrome, and the same close gives the same bytes. The words come from
    `payroll.yaml documents` in the person's language.
15. **Reopening takes the payslip's PDF out of Belege** (receipt, link and file); closing again files the
    new one. An entry of the ref a person changed by hand stays hers and is named.
16. **The social security number's pattern is jurisdiction data** (`payroll.yaml socialSecurityNumber`);
    src/llm/mask.ts masks it in every prompt, system text, judged state and sidebar message.
17. **A payslip's receipt is keyed by its PDF's content** (as the read step keys every file of receipts/),
    typed `payslip` and excluded from every reread and VAT read by kind: the intake never turns it into an
    ordinary receipt, and its text holds no salary.
18. **Closing again after a reopening replaces a person's entry of the payslip's ref** once the warning
    named it and she confirmed: the ref is booked once, from the payslip.
19. **Reopening keeps the PDF while a payment is linked to it** (it is that payment's proof); the next
    close hands the payment's link to the new PDF and removes the old one.
20. **A wage payment is matched by code when its amount is the payout and it names the person** (her IBAN
    valid on the payday, or her first and last name in the bank's text), within two weeks before and a
    month after the payday; one line equal to all of a month's unpaid payouts pays each of them. Booked
    D 1091 / C bank in the intake before any rule or model, with the payslip's PDF linked as its proof.
21. **A payment to a fund or insurer is booked against its liability account only when closed payslips
    accrued onto that account before the payment's day** (a January payment of last year's too; one before
    payroll ran here stays level A's booking, 2270/57xx), only a payment out (what an insurer pays in is
    mostly a benefit), only in the books' currency, and never one a company rule decides. The same holds for
    the wage match; `classify --force` leaves payroll's code bookings in place.
23. **The Lohnausweis PDF prints Form 11's letters and fields in the module's order and words**
    (`payroll.yaml lohnausweis`), drawn with pdf-lib on white paper; each issue is a snapshot in
    `transactional-data/<year>/payroll/lohnausweise.jsonl` with its PDF beside it, and a replacement or a
    correction is a new snapshot that names the earlier one. KTG and UVGZ employee shares go into field 15 as
    remarks, as the market does.
24. **The CSV fallback is one row per person with every field of the form** (and the social security
    number): the free federal tool's import format was not verified, so the table is what a person or a
    fiduciary types in or maps. The declarations' CSV holds every base of the year as the payslips kept it,
    the ALV and UVG wages as capped.
22. **The final statement's (Schlussabrechnung) total is entered by the person** off the statement; code
    books its difference to what the payslips accrued (D 57xx / C 227x, or back), ref `LS-<year>-<insurance>`,
    once. Reading the total off the statement's PDF is for the AI on her drop, later.

---

## Sources

Federal law (fedlex.admin.ch): AHVG Art. 3, 5, 8–9, 13, 14, 51, 64, 68–69, 153b–153i;
AHVV Art. 6, 6quater, 7, 8, 34, 34a, 34d, 35, 36, 157; IVG Art. 3; EOG Art. 27, EOV
Art. 36; AVIG Art. 2, 3, 31; BVG Art. 2, 7, 8, 16, 66; BVV 2 Art. 3, 5; UVG Art. 1a, 8, 15, 91; UVV Art. 13, 22; KVG Art. 67ff; FamZG Art. 5, 12,
15–16; DBG Art. 37a, 83–101, 127; StHG Art. 32–38, 45; QStV (SR 642.118.2); BGSA Art. 2–3; OR Art. 321c, 322d, 323, 323b, 324a, 328b, 329a, 329d, 958f; GeBüV; DSG
(SR 235.1) Art. 5, 8; BGE 129 III 493.

Figures 2026 (checked 2026-11-13):
- BSV, «Entwicklung Beitragssätze 2026»:
  https://www.bsv.admin.ch/dam/de/sd-web/p1k1Z4DTI902/Entwicklung_Beitragss%C3%A4tze_2026.pdf
- AHV/IV Merkblatt «Lohnbeiträge an die AHV, die IV und die EO» (ahv-iv.ch, Merkblätter, Beiträge):
  the online edition found was dated 1.1.2024; check for the 2026 edition.
- SVA Zürich, Lohndeklaration 2026:
  https://svazurich.ch/content/dam/sva-dokumente/2000_ak/2800_vb/2800_vb1_lohndeklaration_2026_023.051.pdf
- Kanton Solothurn, Merkblatt Lohnabzüge 2026:
  https://so.ch/fileadmin/internet/fd/fd-pa/Personalamt/03_Anstellungsbedingungen-GAV/10_Lohnsystem/Merkblatt_Lohnabzuege_2026.pdf
- BSV BVG Masszahlen: https://www.bsv.admin.ch/dam/de/sd-web/GZplHByBJoFc/Internet_Masszahlenarticles_25_26_d.pdf;
  Helvetia Kennzahlen Säule 2: https://www.helvetia.com/ch/consulta/de/home/gut-zu-wissen/kennzahlen-saeule-2.html;
  Raiffeisen Sozialversicherungskennzahlen 2026 (2027 values):
  https://www.raiffeisen.ch/winterthur/de/ueber-uns/news/rb/sozialversicherungskennzahlen-2026.html
- Family allowances: FamZV (Verordnung über die Familienzulagen), which adjusts the minimums
  of FamZG Art. 5 to prices (215/268 from 1.1.2026), on fedlex.admin.ch. The figures are to
  verify against the FamZV text.
- ESTV Quellensteuer: https://www.estv.admin.ch/de/quellensteuer; tariff files:
  https://www.estv.admin.ch/de/quellensteuertarife-fuer-uebrige-einkuenfte; publication 2026:
  https://www.estv.admin.ch/de/newnsb/zvrg4CYct6xo; record format (2025):
  https://www.estv.admin.ch/dam/estv/de/dokumente/qst/qst-tarife-recordformate-einkuenfte-2025-de.pdf.download.pdf/qst-tarife-recordformate-einkuenfte-2025-de.pdf
- SECO, vereinfachtes Abrechnungsverfahren:
  https://www.seco.admin.ch/de/vereinfachtes-abrechnungsverfahren-bei-tiefen-lohnsummen
- Swissdec (ELM 5.0/6.0, certification): https://swissdec.ch; AXA, Elektronische Lohnmeldung:
  https://www.axa.ch/de/unternehmenskunden/melden-und-mutieren/melden/elektronische-lohnmeldung.html
- Minimum wages (secondary, figures differ): https://lohncheck.ch/de/articles/mindestlohn-schweiz-2026;
  SRF on GAV precedence:
  https://www.srf.ch/news/schweiz/gesamtarbeitsvertraege-mindestloehne-branchen-koennten-kuenftig-kantone-uebersteuern
