# Spec: payroll (Lohnbuchhaltung)

Status: decided by the owner, 2026-11-14 (§13); patterns from the market review and the rule
«warn, then the person decides» added 2026-11-15 (§14, §15). No code yet. A clickable prototype of B0 is in
[mockups/payroll/](mockups/payroll/index.html). Builds on
[ADR 0011](../adr/0011-payroll.md) (payroll: book what others calculate, a narrow helper for the
owner's salary) and is judged by [MISSION.md](../../MISSION.md) and
[ADR 0015](../adr/0015-base-cases-in-the-app-long-tail-in-the-workspace.md).

The owner asked: «and how about Lohnbuchhaltung?». This spec answers on two levels:

- **Level A**: book payslips from external payroll software better. ADR 0011 step 1 exists. This
  spec lists what is still missing.
- **Level B**: compute payroll in the app. Starts with ADR 0011 step 2 (the owner's salary). Staff
  (B1) follows once B0 has shipped and a persona round has scored it.

Sections 1 to 3 are findings: what exists, who needs what, what the law requires. Sections 4 to
12 are the proposal. Section 13 holds the owner's decisions. The order is **B0 first**, then A-2,
then B1 (§12).

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
7. **No import of a payroll program's journal.** Bexio, Abacus, Sage, Run my Accounts and the
   Treuhänder all export a «Lohnjournal» or «Buchungsjournal». Today only their PDFs reach the
   app.
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
- Free federal tool: «eLohnausweis SSK». Software may print the form if it matches the Wegleitung.
  Whether the SSK tool reads an import file was not verified: it is checked before B0's year-end
  step (§13, decision 8).

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
  BVG. It is a candidate base case (§4.5, phase B1).

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
  app does not plan it (§11, §13 decision 8): the person uses the fund's portal for the annual
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
| Administration cost, FAK rate, BVG plan, UVG/NBU/KTG premium rates | Y per contract | the firm's fund, insurer, pension fund | the workspace (payroll plan, §5.3), each with the document it is read from |
| Quellensteuer tariffs | Y, corrections during the year | ESTV / cantons | fetched on demand like `npm run fetch-rates` (src/cli/fetch-estv-rates.ts), into the workspace's `data/` per canton and year, with checksum and source date, never in git |
| Minimum wages, GAV minima, 13th salary, holiday weeks | K/G | canton, GAV | workspace knowledge (`knowledge/rules/payroll.guide.yaml`) and the employee's contract |

A test (like tests/vat-golden) fails once a year has wages but `modules/ch/payroll/<year>.yaml`
is missing. In December, a task says «Lohnsätze 2027 fehlen in der App» to the developer, not
to the person (no-nagging-reminders: a fact on the run, not a reminder).

---

## 4. Goals and non-goals

### Goals

- **G1 (A):** a payslip from any payroll program is booked by code, gross, with its deductions on
  the right accounts. 2270 and 2279 stay explained through the year, without an AI.
- **G2 (A):** the year close proves the payroll: 5000 against the payslips' gross, 2270 against
  the funds' final statements, per-employee year totals for the Lohnausweis.
- **G3 (B):** a small firm (owner plus a few people, one canton) runs its monthly payroll in the
  app. It gets payslips as PDF, the bookings, what to pay to whom, the fund reconciliation, and
  the Lohnausweis at year end.
- **G4 (B):** every figure says where it comes from (federal table, the fund's document, the
  contract) and is a calculation to be checked, not advice (ADR 0011).
- **G5:** salary data stay inside the workspace. The model sees what it needs and never an AHV
  number.

### Non-goals

- Swissdec certification and ELM transmission (§11). Reporting stays on paper, the funds' portals
  and eLohnausweis SSK.
- Several cantons of work within one firm, staff posted abroad, expatriate rules, share plans.
- The owner's own AHV as a self-employed person (Einzelfirma).
- Time tracking. Hours come in as a number per month or a CSV, never from a clock-in app.
- HR: contracts, absences, certificates. Only the figures payroll needs are kept.
- Paying wages from the app. A pain.001 file comes only if the invoicing/payments work builds the
  channel (§13, decision 11).
- Hard-coded fund, insurer or GAV figures (ADR 0011 «Rejected»; ADR 0015).

---

## 5. Level A: booking payslips from external payroll

### 5.1 User stories

- *Treuhänder:* «I drop my client's Lohnjournal CSV of the month. Every wage and every deduction
  is booked, and 2270/2279 show what is still owed to whom.»
- *Corinne (webshop):* «I drop the two payslips and the bank statement. The wages are booked gross
  without me answering anything. The Akonto clears exactly what was withheld.»
- *Matthias (consulting):* «Without an AI subscription my salary is still booked gross.»
- *Sandra (painter):* she has only net bank lines. The app books them net (the accepted variant b
  of kit.mjs) and says once, as a fact: «Löhne netto gebucht: ohne Lohnabrechnungen stimmen
  Lohnaufwand und Lohnausweis nicht überein.»

### 5.2 Changes

| # | Change | Who decides | Files |
|---|---|---|---|
| A1 | **Document kind `payslip`.** Recognised by code: the firm is the issuer (`issuedByFirm` ≠ false), the head names a payslip word (a new `documents.yaml` list `payslip: [Lohnabrechnung, Lohnblatt, Salärabrechnung, Gehaltsabrechnung, Décompte de salaire, Bulletin de salaire, Conteggio salario, Busta paga, Payslip]`) and `payslipDeductions` reads. A payslip is never an «own invoice» waiting for its customer (`waitsForCustomer`) and never a bill. | code | modules/ch/documents.yaml, src/intake/document-kind.ts, src/intake/own-invoice.ts, period-issues.ts |
| A2 | **`readPayslip(text)` → `{ employee, period, gross, net, deductions: Map<kind, amount>, allowances, expenses }`**, built on `payslipDeductions`. It needs gross − Σ deductions + allowances + expenses = net to the Rappen, else undefined. The words for gross, net, allowance and expenses come from `setup.yaml wages.payslip` (data, de/fr/it/en), never from code. | code | src/booking/withheld.ts (or a new src/booking/payslip.ts), modules/ch/setup.yaml |
| A3 | **Code books `cls-salary`.** A wage payment linked to a payslip that reads, with net = the bank amount: D 5000 / C bank (net); D 5000 / C 2270 for the social deductions; D 5000 / C 2279 for kind `tax`; an allowance D 2270 / C bank (the fund refunds it on its bill; §13, decision 10); expenses D 5820/5830 / C bank. `by: { kind: 'code', check: 'payslip' }`. A payment of several wages (one bank line, several payslips) books each payslip as its own lines. The model is not asked. Without a payslip, the payment is booked net as today (ev-exempt-wages), and when a payslip comes later, code books it again (as `bookWithheldShares` does, never a person's booking). | code | src/booking/classify.ts, processes/booking.guide.yaml cls-salary (→ status: accepted), **books schema step** for the new check (§7.1) |
| A4 | **Quellensteuer as a kind with a payee.** `setup.yaml wages.withholdsTo: { tax: "2279" }` (per-kind deductions account; 2270 stays the default). A business file whose `collects: [tax]` names the cantonal tax office routes its payment to clear 2279. The Bezugsprovision (payment < 2279's share) books C 3xxx/6xxx «Bezugsprovision Quellensteuer» (account in setup.yaml). | code; the person names the tax office's file once | modules/ch/setup.yaml, processes/authorities/steuerverwaltung.yaml (fact `withholding`, DBG Art. 88), src/booking/withheld.ts `fundShare` per account |
| A5 | **Generic payees for pension, accident, sickness.** A business file may say `collects: [pension]` (a contract, not a name). The app's `wages.payees` becomes «ausgleichskasse **plus** every file that declares `collects`». The workspace grows the fund's file. The AI drafts it from the first bill, and the person keeps it on its card. `fundShare` then works for the pension fund too. | code + AI drafts + person keeps | src/knowledge/ (file schema), src/booking/withheld.ts, processes/README.md |
| A6 | **Payroll journal import.** A payroll program's CSV export, recognised by the columns a business file names (`payroll: { reports: { journal: { columns: … } } }`, exactly like `provider.reports.sales` in src/booking/sales-report.ts). It is booked as entries per employee and month by ref `LJ-<business>-<period>-<employee>`, once. The person names the program's file. The app ships the contract and one reference file in tests, no vendor (ADR 0015 row 4). | code (contract), AI writes the column map with the person | src/intake/ (new payroll-journal-import.ts), src/booking/ |
| A7 | **Year-close checks (facts, not reminders):** (a) 5000 of the year = Σ gross of the year's payslips, per employee; difference named. (b) 2270 at 31.12. = Σ what the funds still bill, per kind (from `fundShare`'s arithmetic). (c) The final statement of the fund (Schlussabrechnung) is booked: its difference to the Akontos on 5700 against 2270, proposed by code from the statement's total and the Akontos booked (the `socialInsurance` template becomes a proposal). (d) Per-employee year totals in Lohnausweis fields 1, 8, 9, 10.1, 11, 12, 13 from the payslips read, shown on a «Lohnausweis-Daten» page and exported as CSV for the person or the Treuhänder. | code | src/accounting/year-close.ts, src/app/areas/close/steps.ts, modules/ch/year-end.yaml, processes/year-close.flow.yaml (new step `payroll-check`) |
| A8 | **Salary data marked as such.** A receipt of kind `payslip` is sent to the model only when code cannot read it, and then without its AHV number (a 756.xxxx.xxxx.xx pattern masked before the call, and never in a model prompt). The AI's facts name totals, not persons' wages, unless the person asks about one. | code | src/llm/prompts.ts, src/intake/ (a mask step), docs/0.4.0/ privacy note |
| A9 | Close #383 and #359 on the way: the wage rule books when kept, and code books wages without an AI. | code | src/saving/wage-rule.ts |

### 5.3 Data

- No new store. `Receipt` gains `kind: 'payslip'` if the receipt kinds are typed (check
  src/types/index.ts). Its read figures are derived on every read (as `order-pages.ts` is,
  #253), not stored, so a better reader re-reads old payslips.
- JournalEntry `by.check` gains `'payslip'` and `'payrollJournal'`. That is a **books schema step
  (9 → 10)** with an empty migration, like schema 9 for `withheldShare`. Decided: one step for all
  three checks (§13, decision 5).
- Business files gain `collects: [<kind>]` and `payroll.reports.journal`. That is a knowledge-file
  schema change (src/knowledge/), not a books or manifest step.

### 5.4 Acceptance (persona walk, level A)

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

## 6. Level B: payroll computed in the app

### 6.1 Scope ladder

| Step | In | Out | Persona |
|---|---|---|---|
| **B0** (= ADR 0011 step 2) | one person, the owner, employed by a GmbH/AG, resident in CH, fixed monthly wage, optional 13th; AHV/IV/EO, ALV, BVG from the fund's certificate, NBU/KTG from the policy; payslip PDF; bookings; Akonto vs final statement; year totals for the Lohnausweis | other employees, hourly pay, Quellensteuer | Matthias (consulting), demo-consulting |
| **B1** | up to ~10 employees, one canton of work; monthly or hourly (with holiday and public-holiday surcharges shown separately); 13th pro rata; entry/exit mid-year; BVG threshold, ALV ceiling and AHV age rules computed by code; family allowances paid through; the simplified procedure (VAV) for an Einzelfirma; Lohnausweis PDF (Form 11) | Quellensteuer, several cantons | Corinne + Jana (webshop), Sandra + Marco (Huber), demo-schreinerei, coiffeur with a helper |
| **B2** | Quellensteuer: tariff code per employee, the canton's tariff file, monthly or annual model by canton, Bezugsprovision, the settlement list per canton, entry/exit reports | cross-border regimes other than the canton's tariff files | none today. Needs a new persona (a cross-border employee from DE) |
| **B3** | Treuhänder mode: several firms' runs from one desk, an export of the year for ELM-capable software | ELM itself | Treuhänder |

ADR 0011 rejects «full payroll in this app now». B1 and B2 go beyond it. B0 does not. Decided: the
ADR is amended for B1 only after B0 ships and a persona round scores it. B2 and ELM stay out
until a firm asks (§13, decision 3).

### 6.2 User stories

- *Matthias (B0):* «Firma › Löhne: I enter my salary of 9,500, the BVG contributions from my
  fund's certificate (290 employee, 290 employer, or the plan's split), my NBU and KTG rates from the
  policy. On the 20th the app shows the July payslip. I click «Freigeben». The payslip PDF is in
  Belege, the booking is in the journal, and the payment I make in e-banking is matched by code.»
- *Corinne (B1):* «Jana works hours. I type 70 h for August. Her payslip shows the hourly wage, the
  holiday surcharge (4/48) on its own line, AHV/ALV and NBU, and no BVG: below the threshold, the
  app says so on the payslip's detail.»
- *Sandra (B1):* «mach d Lohnabrechnig für de Marco». The sidebar opens Marco's August run with the
  figures of July and asks only what changed (hours, bonus). She checks it and releases it. The
  wish has been carried out, not answered with a sentence.
- *Corinne (B1, year end):* «Lohnausweise 2026» in Abschluss: two PDFs, Form 11 fields filled,
  each figure linked to the payslips it sums. The AHV Lohnbescheinigung's figures per person are
  ready to type into the fund's portal.
- *Coiffeur (B1, VAV):* «Ich stelle eine Aushilfe ein, 600 im Monat.» The app proposes the
  simplified procedure (Einzelfirma, below both limits), books the monthly wage, and in January
  shows the one annual figure for the fund.
- *Employee:* receives the payslip PDF by mail from the firm's mailbox (the invoicing mail path),
  in their language.
- *Auditor:* every payslip figure traces to a rate with its source and to the run that produced it.
  A released run changes only by «Wieder öffnen», and the run's history keeps each release and
  each reopening with its date and who did it.

### 6.3 What code, the AI and the person decide

| Task | Code | AI | Person |
|---|---|---|---|
| Federal rates, thresholds, ceilings, age rules, pro rata, cumulative ALV ceiling, BVG entry by annual wage, rounding | ✓ (from `modules/ch/payroll/<year>.yaml`) | – | overrides with a reason (kept on the run) |
| Fund and insurer rates (admin cost, FAK, BVG plan, UVG/NBU/KTG) | checks plausibility (range per kind in the module) | reads the certificate or policy the person drops and **proposes** the figures with the document | confirms them on a card: nothing is used before she keeps it |
| Master data (entry date, pensum, wage, 13th, holiday weeks) | validates (minimum wage warning where the canton's or GAV's minimum is known as data) | reads an employment contract and proposes | enters or confirms |
| Quellensteuer tariff code | looks up the amount in the tariff file | – | enters the code from the employee's declaration. Without it, the run shows the Quellensteuer line «unvollständig» and «Freigeben» warns that no tax is withheld and that the employer is liable for it (DBG Art. 88); she may release anyway (§15) |
| Family allowance claim | adds it to the payslip once confirmed | – | enters what the fund confirmed |
| Each run | computes it, makes the payslip and the entries, matches the payment | explains a figure when asked («wieso isch de Lohn tüüfer?») | sees the bookings the run will make, then releases it (`Freigeben`); only then is anything booked |
| Corrections | in an open period: reopens the run, takes back its entries and books it again on the next release; in a closed period: a correction run in the next open month | – | reopens the run (`Wieder öffnen`) after a plain warning, or asks for a correction run |
| GAV rules (minimum by age or class, Parifonds deduction, 13th mandatory) | executes them as data | drafts them into `knowledge/rules/payroll.guide.yaml` from the GAV text with the person | keeps them |

«Possible without the AI»: every AI row has a form. B0 and B1 work entirely without an AI.

### 6.4 App vs. workspace (ADR 0015)

| In the app | In the workspace |
|---|---|
| The payroll engine (src/payroll/, generic: contributions as kinds from data, no Swiss name in code; the layers lint, tests/layers.test.ts, refuses AHV or BVG outside modules/ch) | The firm's plan: its compensation fund, FAK rate, admin cost, pension fund plan, insurers' rates, each with its source document (`payroll.json`, §7) |
| `modules/ch/payroll.yaml`: the kinds (AHV/IV/EO, ALV, BVG, UVG-BU, UVG-NBU, KTG, FAK, QST), who pays what by law, which wage each applies to, the Lohnausweis field each feeds, payslip labels de/fr/it/en | GAV rules of one branch (painters, joiners): `knowledge/rules/payroll.guide.yaml`, written by the AI with the person |
| `modules/ch/payroll/<year>.yaml`: federal figures with sources | A cantonal FAK amount above the federal minimum (the canton's figure, kept by the firm with its fund's letter) |
| The fetch of tariff files and the tariff lookup (a documented public format) | Which canton's tariff, and the employees' codes |
| Invariants: a released run changes only through «Wieder öffnen» (its history kept), closed periods, the write door (`update(books, moduleActor('payroll'), …)`), seals | The fund's or insurer's portal and its upload format (a source the AI writes, ADR 0014) |
| Payslip and Lohnausweis PDF layout (one base layout, like src/invoices/pdf.ts) | The firm's letterhead (the invoice layout's logo reused) |
| The base errors: missing rate, missing tariff code, a wage under a known minimum, the BVG threshold crossed mid-year, the ALV ceiling reached | – |

No branch for one fund, insurer, canton or payroll vendor in src/. A canton's specifics (Bezugsprovision,
the annual vs monthly Quellensteuer model, the FAK minimum) are rows of `modules/ch/payroll/<year>.yaml`
keyed by canton, as data.

### 6.5 A run

1. **Draft** (code): for the month, per active employee: the last run's figures with this month's
   changes. Every line carries `{ kind, base, rate, source }` and shows **base × rate = amount**
   (a monthly wage: 1 month × the monthly wage; AHV/IV/EO: the AHV wage × the federal rate; a
   fixed BVG contribution: «fest», with the certificate as its source). A switch beside the table shows the
   employer's share of each kind next to the employee's (rate and amount), and the kinds only the
   employer pays (FAK, administration cost). Off by default: the payslip is the employee's view.
   The lines come in groups named by their effect:
   - **«Zählt zum Bruttolohn (AHV-pflichtig)»**: wage, hours × rate, holiday surcharge, 13th share,
     bonus, and wage in kind (the private share of a company car, Lohnausweis field 2.2);
   - **deductions** per kind (rate × the base that kind applies to, with ceilings cumulated over
     the year), allowances;
   - **«Ausserhalb des Bruttolohns»**: expenses, an advance and its repayment, a wage garnishment
     (Lohnpfändung) paid to the debt collection office. None of them is in the AHV wage; each
     books on its own account (§6.5 step 4 lists them).
   Then the net, and the employer's contributions per kind.
2. **Check** (code): the base errors above. A missing input is **its own line**, in red, marked
   «unvollständig», saying what is missing («Kaufpreis fehlt»), with a field to enter it in place.
   Code computes no amount for it, never a guessed one. It is a warning, not a block: the run can
   be released with it (step 3). The other checks are listed beside the run as facts.
3. **Preview** (code): the draft shows, below the lines, every entry the release will book (debit,
   credit, text, amount, the payday and the ref), and the later payment D 2290 / C bank. Nothing is
   booked yet. The preview is the same function that books (one source), so what it shows is what
   the release writes.
4. **Release** (person): `Freigeben`. With a line «unvollständig», the click first says what is
   off, which rule it touches and what follows («Privatanteil Geschäftsfahrzeug hat keinen
   Kaufpreis. Regel: der Privatanteil zählt zum AHV-pflichtigen Lohn und gehört in Ziffer 2.2.
   Gibst du trotzdem frei, sind AHV, ALV und Ziffer 2.2 um ihn zu tief; der Nettolohn bleibt
   wie berechnet»), then «Trotzdem freigeben» or «Zurück zum Entwurf». The release is recorded like any
   other (who, when); there is no override flag on the run. At release:
   - the payslip PDF per employee goes into `transactional-data/<year>/receipts/` as a receipt of
     kind `payslip`, linked to the run (so level A's code reads it the same way, and `fundShare`
     can take its deductions from the run directly instead of from text);
   - the entries are booked per employee on the payday by ref `LR-<yyyy>-<mm>-<employeeId>`:
     D 5000 / C 2290 «Lohnverbindlichkeiten» (net, a new account; §13, decision 12), D 5000 / C 2270
     (social deductions), D 5000 / C 2279 (QST), D 2270 / C 2290 (allowances paid through), D
     57xx / C 2270 (the employer's contributions accrued per kind, so 2270 holds the whole debt
     to each fund). Outside the gross: expenses D 5820/5830 / C 2290, an advance D 1xxx
     (receivable from the employee) / C 2290 and its repayment the reverse, a garnishment D 2290 /
     C 2xxx (the debt collection office, paid from there). Stamped `by: { kind: 'code', check:
     'payroll' }`, `run: <runId>`;
   - the bank payment of the net is later matched by code (amount + employee name/IBAN) and books
     D 2290 / C bank.
5. **Funds:** the Akonto and final bills are paid against 2270 only, since the expense was
   accrued in the run. The fund reconciliation per kind: accrued by runs − paid = open, shown on
   the Löhne area per fund. The final statement's difference is booked by code once its bill is
   linked: D/C 57xx against 2270 (the difference between the Akonto basis and the real wage
   sum).
6. **Reopen** (person): a released run in an open period has «Wieder öffnen». The click first
   says plainly what follows, then «Wieder öffnen» or «Abbrechen»:
   - the run's entries (its ref) are taken back, and the next release books them again;
   - the payslip stays in Belege; the new release's payslip replaces it, and a payslip already
     sent stays in the sending log;
   - a payment already made stays matched to the run. If the new net differs, the difference is
     an open amount on 2290, shown as a fact on the run and on the payment, never a reminder;
   - the funds on 2270 count with the new run.
   The reopening is recorded in the run's history like any other action (who, when). No override
   flag, no «despite the warning» mark. Taking the entries back goes through the write door as
   the person, so a person's own change of a run entry stays (it is hers).
7. **Correction in a closed period:** a run whose payday lies on or before `closedThrough` has no
   «Wieder öffnen». It gets a correction run in the next open month (lines «Korrektur Juli», with
   `corrects: <runId>`). This follows AGENTS.md golden rule 1 and the period lock as they stand:
   payroll carries no VAT, but the books are sealed per quarter. The owner's rule «warn, then the
   person decides» (§15) would let a person reopen such a run after a warning
   («Der Lauf liegt im eingereichten Quartal Q1 2026. Wieder öffnen ändert Buchungen, die versiegelt
   und der ESTV gemeldet sind …»); the app keeps the hard lock until the owner rewrites golden rule 1.

Accruing the employer's share in the run (step 3) differs from level A, where it is expensed at
payment. Both are correct. The run's way gives monthly expense and a 2270 that matches the funds.
A firm switching from A to B mid-year must not book the share twice: code books a contribution
payment's employer line against 2270 for a period whose runs accrued it, never on 57xx. A person
who books it on 57xx by hand is warned that the share is then expensed twice (rule: one expense
per contribution, §13 decision 9) and may keep it (§15).

### 6.6 Year end (B1)

- Lohnausweis per employee (Form 11 fields, §3g), from the year's released runs, as PDF in the
  employee's language. Plus a CSV of every field for eLohnausweis SSK or the Treuhänder.
- AHV Lohnbescheinigung figures per person (AHV wage, ALV wage, period), and UVG/KTG wage sums
  per insurer: shown for the person to submit by the fund's channel.
- BVG: the wages to report to the pension fund.
- Close checklist (src/app/areas/close/steps.ts): «Lohnausweise», «Lohnbescheinigung AHV», «2270 je
  Kasse ausgeglichen», each a state, not a reminder.

### 6.7 Quellensteuer (B2)

- The employee gets `taxAtSource: { canton, code, church, since }`. The run looks up the tariff in
  `data/qst/<year>/<canton>.txt` (fetched by `npm run fetch-qst -- <canton> <year>`, checksummed,
  with the ESTV's source date). Without the file, the Quellensteuer line is «unvollständig»: «Tarif
  <canton> <year> fehlt». Code never guesses an amount. Releasing anyway follows §6.5 step 4: the
  warning says that no tax is withheld and that the employer is liable for it.
- The monthly or annual model per canton (data). Annualisation for irregular pay (QStV).
- Settlement list per canton and period (the canton's form fields), the Bezugsprovision booked
  C 2279 → C <provision account> on settlement.
- Entry and exit reports within the canton's deadline, as facts on the run.
- Golden set of hand-worked cases per tariff file version. A tariff correction during the year
  (AG, 4.3.2026) means: runs released before keep their figure, and the difference goes into the
  next run as a correction line, by the person's click.

---

## 7. Data model additions

### 7.1 Books (ledger, `BOOKS_SCHEMA` 9, src/workspace/schema.ts)

- `JournalEntry.by.check` gains `'payslip'` (A3), `'payrollJournal'` (A6) and `'payroll'` (B).
  `JournalEntry.run` already exists. That makes **books schema 10** with an empty migration step,
  one step for all three, taken with the first phase that books a payroll check (§13, decision 5;
  AGENTS.md «Versions and data format»).
- Refs `LR-…` (runs), `LJ-…` (journal import): new ref prefixes. Check `transactionRef` consumers
  that assume a bank ref or `M`/`RE`/`GS`. No schema change if refs are free text, which they
  appear to be.
- Accounts: 2290 Lohnverbindlichkeiten (B only), a Bezugsprovision account (A4). Chart additions
  in modules/ch/accounts.yaml, added to a workspace's accounts.json by the setup (src/workspace/scaffold.ts).

### 7.2 A new store: `payroll.json` (B only)

Beside `invoices.json` (LAYOUT top, owner `app`), with its own `PAYROLL_SCHEMA = 1` and ladder in
src/workspace/schema.ts. The manifest stays unchanged (no `WORKSPACE_SCHEMA` step), because payroll's
setup lives in its own store. Decided: `payroll.json`, not a `company.payroll` manifest section
(§13, decision 6).

```ts
interface PayrollStore {
  schema: 1;
  plan: {                                   // per year, the firm's contracts
    [year: string]: {
      canton: string;                       // of work (one, B1)
      funds: Array<{ kind: string; business: string;          // knowledge file id
                     rates: Record<string, number>;           // e.g. { adminCost: 2.5, fak: 1.1 } in %
                     source: { receiptId?: string; note: string; keptAt: string } }>;
      pension?: { business: string; perEmployee: true };      // figures per employee below
      accident: { business: string; bu: number; nbu: number; nbuPaidBy: 'employee' | 'employer' | 'split'; source: …};
      sickness?: { business: string; rate: number; employeeShare: number; source: … };
      vav?: true;                                               // simplified procedure (Einzelfirma only)
    };
  };
  employees: Array<{
    id: string; name: string; address: string; language: 'de'|'fr'|'it'|'en';
    ahvNumber?: string;                    // AHVN13; masked in every UI list, never to the model
    birthDate: string; entry: string; exit?: string; isOwner?: true;
    iban?: string;                         // for matching the net payment
    contract: Array<{ from: string; kind: 'monthly' | 'hourly'; amount: number; pensum?: number;
                      thirteenth?: boolean; holidayWeeks: number; publicHolidaySurcharge?: number }>;
    pension?: Array<{ from: string; employee: number; employer: number; source: … }>;  // CHF per month, from the certificate
    allowances?: Array<{ from: string; to?: string; kind: 'child' | 'education'; amount: number }>;
    taxAtSource?: { canton: string; code: string; church: boolean; since: string };  // B2
  }>;
}
// Per year: transactional-data/<year>/payroll/runs.jsonl — append-only: one line per release, and a line
// { id, reopenedAt, reopenedBy } per reopening; the last release of an id is the run, the earlier ones its history:
interface PayrollRun { id: string; period: 'YYYY-MM'; payday: string; releasedAt: string; releasedBy: 'person';
  corrects?: string; slips: Array<{ employee: string; lines: Array<{ kind: string; label: string;
  base?: number; rate?: number; amount: number; party: 'employee'|'employer'|'paid'; source: string }>;
  net: number; receiptId: string }>; entries: string[] }
```

LAYOUT (src/workspace/workspace.ts) gains `top['payroll.json']` and `year['payroll']`. `npm run
doctor` names them.

### 7.3 Module data (no schema step)

- `modules/ch/payroll.yaml`: kinds, legal splits, bases, Lohnausweis fields, labels (de/fr/it/en),
  plausibility ranges.
- `modules/ch/payroll/2026.yaml`: §3l's federal rows, each `{ value, source, validFrom }`.
- `src/core/modules/schema.ts`: the types of both. `modules/ch/module.yaml` `provides:
  accounting.payroll.runs@1` (the capability is already named in docs/0.4.0/inspiration/capabilities.yaml).

---

## 8. Security and privacy of salary data

Today the workspace is a git repository (ADR 0013). Everyone with access to it sees every receipt,
so every payslip and so every salary. That is acceptable for an owner who keeps the books alone.
It is not acceptable once a bookkeeper or an employee who scans receipts has access.

- **The store.** `payroll.json` and `payroll/` sit in the workspace, versioned (10-year retention,
  OR 958f; the audit trail of a released run). The alternative of encrypting them with the
  desktop's sealed store (src/secrets/sealed-store.ts) breaks git history, diff and the auditor's
  copy. Decided: plain in the workspace, no encryption, with access controlled at the repository,
  and said so in setup («Wer die Buchhaltung öffnet, sieht die Löhne») once a firm has staff
  (§13, decision 4).
- **The accountant.** Wages are not hidden from the accountant or the Treuhänder. The net shows in
  every bank line, and the accountant needs the gross anyway.
- **The model.** No AHV number in any prompt (masked by pattern before every call, tested). Payroll
  runs never call the model. Reading a certificate or contract is the only AI step, and it is the
  person's explicit drop. The AI's facts list payroll totals, not names with wages, unless the
  person asks.
- **The public repo.** Test fixtures use invented people only (persona names already in the
  repo). check-public (src/publish/leak-guard.ts) must treat `payroll.json` and `payroll/` like
  `receipts/`: company files, never in public-files.txt.
- **Mail.** Payslips go to an employee's own address only, from the firm's mailbox. The address is
  part of master data. No bulk «send to all» without showing each recipient.
- **Exports.** The audit export (docs/audit-export.md) includes payroll for the auditor. A
  Treuhänder export may leave out AHV numbers on request.
- **Health data.** No sick-leave or accident reasons are stored, only wage-relevant figures (e.g.
  «KTG-Taggeld 2,300» as a line).

---

## 9. UI

- **The run's detail** (prototype: [2-lauf.html](mockups/payroll/2-lauf.html)): the lines as base ×
  rate = amount in the two groups, the switch «Arbeitnehmer | + Arbeitgeber», a line
  «unvollständig» in red (`var(--neg)`) with its field, the preview «Bucht beim Freigeben», the
  warning above the table when «Freigeben» or «Wieder öffnen» is clicked (a panel in the page,
  not a modal dialog), and the run's history («Verlauf») in the margin.
- **New area «Löhne»** (src/app/areas/payroll/, registered in src/app/areas/index.ts; list + detail
  per the shell, docs/redesign/architecture.md). The list holds the runs per month in the period
  (draft, released, correction). The detail shows the run's payslips, each line with its source
  on hover, the checks as tasks, `Freigeben`, and the PDF. A second list holds the employees,
  each with a detail (contract history, pension figures, allowances, year totals). URLs:
  `/payroll/<runId>?period=2026-Q3`, `/payroll/employee/<id>` (docs/urls.md, built by `hrefOf`).
  The area shows only when `employs(profile)` (B) or payslips exist (A: the «Lohnausweis-Daten»
  page alone).
- **Firma › Löhne:** the year's plan (funds, insurers, rates with their documents), the canton,
  VAV on/off. Like Firma › MWST.
- **Abschluss:** the steps of §5.2 A7 and §6.6.
- **Journal / Bank:** a wage entry links to its payslip and run. A fund payment shows «Kasse X:
  aufgelaufen … bezahlt … offen …».
- **Sidebar wishes:** «mach d Lohnabrechnig für Marco» opens the draft run; «Marco verdient ab
  September 5'400» drafts a contract line on a card; «wieso isch de Lohn tüüfer» explains from the
  run's lines.
- Colours and classes per UI theming (tokens.css). The payslip and Lohnausweis sheets keep paper
  colours, like the invoice sheet.

### i18n

- Every UI text through `t()`, de first, fr/it/en matching (docs/i18n.md, tests/i18n.test.ts). New
  key groups `payroll.*`, `firma.payroll.*`, `close.payroll.*`.
- The **documents** (payslip, Lohnausweis) are printed in the employee's language, not the UI
  language. Their labels come from `modules/ch/payroll.yaml` (AHV/AVS/AVS, ALV/AC/AD, BVG/LPP/LPP,
  NBU/AANP/AINP, Quellensteuer/impôt à la source/imposta alla fonte), not from the UI dictionaries.
  The layers lint stays green.
- Limits named when hit (AGENTS.md): e.g. «10 Personen pro Lohnlauf in dieser Version: 2 weitere
  nicht berechnet» if B1 caps the number of employees.

---

## 10. Tests and golden-master impact

- **VAT golden master** (tests/vat-golden.test.ts): payroll lines carry no VAT code, so no Ziffer
  moves. **But** tests/golden/demo-consulting/books.json and demo-schreinerei/books.json change if
  the demo generator switches its wages from `M2026-0xx` manual entries to payslip-booked (A) or
  run-booked (B) entries. Recommendation: A changes the generator to emit a payslip PDF per month
  and lets code book it, so the books change in refs and `by` but not in amounts. Update with `npm run
  test:update` and review the diff. That is not a «⚠ figures» change (no VAT figure moves), but
  the owner reviews it as a books change.
- **New hand-worked golden set** `tests/golden/payroll/` (like tests/firm-types.test.ts): per case
  a set of inputs and the expected payslip lines to the Rappen:
  - owner 9,500 with BVG 290 (Matthias): AHV/IV/EO 503.5, ALV 104.5, BVG 290, net 8,602
    (the figures of persona-files/kit.mjs);
  - part-time 1,550 (Jana): AHV/IV/EO 5.3 % and ALV 1.1 % to the Rappen, no BVG (annual 18,600 < 22,680), NBU at the policy's
    rate;
  - hourly 70 h × CHF 25 + the 4/48 holiday surcharge;
  - a December bonus crossing the ALV ceiling (cumulative);
  - an employee turning 65 mid-year (Freibetrag, no ALV from the month after);
  - an employee turning 18 (AHV from 1 January after the 17th birthday);
  - an exit on 15 March (13th pro rata, BVG pro rata);
  - wages under 2,500 a year (AHV exempt unless asked);
  - VAV helper of an Einzelfirma;
  - B2: one tariff code per canton file version, checked against the ESTV file.
- **Property tests:** net = gross − deductions + allowances + expenses; Σ runs = Lohnausweis
  field 8; 2270 = accrued − paid per kind; a released run changes only through a reopening, which
  takes back exactly its own entries (books-store write door) and appends to its history; the preview
  of a draft equals the entries its release books.
- **Period lock:** a row in tests/period-lock.test.ts for every new route that writes
  (`POST /api/payroll/runs/:id/release`, `…/reopen`, corrections). A run dated in a closed period is
  refused (golden rule 1 as it stands, §6.5 step 7).
- **Warnings, not blocks:** a run with a line «unvollständig» is released after the warning, with
  the line left out of every figure; the release carries no flag (tests assert the absence).
- **Level A tests:** payslip kind recognition (de/fr/it texts; a Treuhänder's invoice naming «Lohn»
  is **not** a payslip), `readPayslip` sums, A3 booking without an AI, the late-payslip rebook,
  A6 import idempotence, A8 masking (no `756.` pattern in any captured prompt).
- **Persona walks:** first-run-webshop and first-run-consulting gain checkpoints (§5.4, §12).
  wishes.md §6 changes from «honest no» to «carried out» for the payslip wish once B1 is built.

---

## 11. Swissdec certification: effort and risk

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

---

## 12. Phased plan

Each phase ends with acceptance checks a persona walk can score (first-run.md style: pass/fail
per checkpoint, AI on and off).

The order follows the owner's decision of 2026-11-14 (§13, decisions 1 and 2): **B0 first**. The
owner's own firm is a one-person GmbH that runs its payroll itself, with no payroll provider and
no Treuhänder doing the payroll. The app must work for that firm first. Most small Swiss firms
have a Treuhänder or their accounting software run payroll, or the owner does it himself. A
dedicated payroll provider is rare for a micro firm. So the payslips the app reads (level A) come
second, and staff (B1) third.

| Phase | Content | Rough effort | Acceptance (scored) |
|---|---|---|---|
| **B0** | ADR 0011 step 2: the owner is the only employee of a GmbH or AG. Wage from the fund's certificates, monthly run, payslip PDF, run → entries → payment match, 2270 reconciled per fund, year totals for the Lohnausweis. `payroll.json`, `modules/ch/payroll{,/2026}.yaml`, the Löhne area, Firma › Löhne. From A-1 it takes only what B0 needs: the document kind `payslip` (A1, so a run's payslip is never an own invoice or a bill) and booking the gross wage by code, without an AI (A3 for the run's own payslip). Books schema 10. Before the year-end step: check whether eLohnausweis SSK imports a file (decision 8) | 4–6 weeks | consulting walk (owner-employee): salary set up in < 5 min from the fund's certificate (AI proposes, he keeps). July run figures = golden case 1 to the Rappen. The bank's net matched by code. 2270 per fund = 0 after the Q3 bills. Year totals = Σ runs, field by field. A run with a line «unvollständig» is released after the warning; a released run of an open quarter is reopened and released again, and its entries are the same refs once. Without an AI the same by forms. Prototype: [mockups/payroll/](mockups/payroll/index.html) |
| **A-2** | Payslips a Treuhänder or a program issues: the rest of A-1 (A2 `readPayslip` for external payslips, A3 for them, A9: #383, #359), A4 Quellensteuer on 2279, A5 `collects:` for pension, accident and sickness clearing, A8 masking | 3–4 weeks | §5.4 checks 1–3 pass with the AI **off**. Webshop walk: the pension fund's payment clears exactly the BVG share once its file is kept. A payslip with QST books 2279. No `756.` in any prompt (test). withheld-*.test.ts stay green |
| **B1** | staff, hourly, 13th, entry/exit, thresholds, allowances, VAV, Lohnausweis PDF, payslip mail. Starts only after B0 has shipped and a persona round has scored it; ADR 0011 is amended then (decision 3) | 6–10 weeks | webshop walk: Jana's hourly run with surcharge, no BVG with the reason shown. Huber walk: «mach d Lohnabrechnig für Marco» opens the run and books it after release. Golden payroll set green. Lohnausweis field 8 = Σ runs |
| **A-3** | A7 year-close checks for external payslips and the Lohnausweis data CSV for them; A6 payroll journal import (contract + test reference) | 2–3 weeks | §5.4 checks 4–5. Year close of demo-consulting shows 0 differences, and a broken payslip shows its CHF 10 |
| B2 | Quellensteuer computed | 4–8 weeks per first canton, then data | not planned: only when a firm asks (decision 3). Then a new persona (cross-border from DE) |
| B3 | Treuhänder multi-firm, export for ELM software | open | not planned |

The efforts are one developer's estimates with agents doing the programming, before review and
persona rounds.

---

## 13. The owner's decisions (2026-11-14)

The owner answered the open questions of the draft on 2026-11-14. Each item says what was
decided.

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

## 14. Patterns taken from the market review (2026-11-15)

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

## 15. Warn, then the person decides (owner, 2026-11-15)

Wherever this spec would stop a person, the app says what is off, which rule it touches and what
follows, and offers «Trotzdem …». The action is recorded like any other (who, when, in the run's
history or the journal); there is no override flag and no «despite the warning» mark. In this spec:

| Where | Was | Now |
|---|---|---|
| A line without its input (rate, base, tariff code, Quellensteuer tariff file) | the run waits | the line is «unvollständig», «Trotzdem freigeben» after the warning (§6.5 steps 2 and 4) |
| A released run with a mistake | correction run only | «Wieder öffnen» in an open period (§6.5 step 6) |
| A contribution's employer share booked by hand on 57xx after runs accrued it | code refuses | warning of double expense, the person may keep it (§6.5) |
| A wage under a known minimum (canton, GAV) | warning | unchanged: a warning |

Not covered, by the owner's exception for security boundaries and by golden rule 1:

- **Security boundaries stay hard:** no AHV number to any model, payslips only to the employee's
  own address, a released run's history never rewritten (§8).
- **Filed VAT quarters and the period lock:** the app's hard lock (AGENTS.md golden rule 1,
  `closedThrough`, seals) stays until the owner rewrites that rule. The spec only describes the
  warning such a reopening would show (§6.5 step 7); it is not built.

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
- Family allowances: bexio summary of FamZG Art. 5 (215/268 from 1.1.2026),
  https://www.bexio.com/de-CH/blog/view/familienzulagen. Verify against the FamZV text on fedlex.
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
