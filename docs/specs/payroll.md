# Spec: payroll (Lohnbuchhaltung)

Status: draft for the owner, 2026-11-13. No code yet. Builds on
[ADR 0011](../adr/0011-payroll.md) (payroll: book what others calculate, a narrow helper for the
owner's salary) and is judged by [MISSION.md](../../MISSION.md) and
[ADR 0015](../adr/0015-base-cases-in-the-app-long-tail-in-the-workspace.md).

The owner asked: «and how about Lohnbuchhaltung?». This spec answers on two levels:

- **Level A**: book payslips from external payroll software better. ADR 0011 step 1 exists. This
  spec lists what is still missing.
- **Level B**: compute payroll in the app. Starts with ADR 0011 step 2 (the owner's salary) and,
  if the owner agrees, goes further than ADR 0011 allows today.

Sections 1 to 3 are findings: what exists, who needs what, what the law requires. Sections 4 to
12 are the proposal. Section 13 lists the questions only the owner can answer.

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
  Whether the SSK tool reads an import file was not verified: see open question Q8.

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
  channel (open question Q11).
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
| A3 | **Code books `cls-salary`.** A wage payment linked to a payslip that reads, with net = the bank amount: D 5000 / C bank (net); D 5000 / C 2270 for the social deductions; D 5000 / C 2279 for kind `tax`; an allowance D 2270 / C bank (the fund refunds it on its bill; see Q10); expenses D 5820/5830 / C bank. `by: { kind: 'code', check: 'payslip' }`. A payment of several wages (one bank line, several payslips) books each payslip as its own lines. The model is not asked. Without a payslip, the payment is booked net as today (ev-exempt-wages), and when a payslip comes later, code books it again (as `bookWithheldShares` does, never a person's booking). | code | src/booking/classify.ts, processes/booking.guide.yaml cls-salary (→ status: accepted), **books schema step** for the new check (§7.1) |
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
  (9 → 10)** with an empty migration, like schema 9 for `withheldShare`. Owner decides (§7.1).
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

ADR 0011 rejects «full payroll in this app now». B1 and B2 go beyond it. B0 does not. The owner
decides whether to amend the ADR (Q3).

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
  A released run is never changed.

### 6.3 What code, the AI and the person decide

| Task | Code | AI | Person |
|---|---|---|---|
| Federal rates, thresholds, ceilings, age rules, pro rata, cumulative ALV ceiling, BVG entry by annual wage, rounding | ✓ (from `modules/ch/payroll/<year>.yaml`) | – | overrides with a reason (kept on the run) |
| Fund and insurer rates (admin cost, FAK, BVG plan, UVG/NBU/KTG) | checks plausibility (range per kind in the module) | reads the certificate or policy the person drops and **proposes** the figures with the document | confirms them on a card: nothing is used before she keeps it |
| Master data (entry date, pensum, wage, 13th, holiday weeks) | validates (minimum wage warning where the canton's or GAV's minimum is known as data) | reads an employment contract and proposes | enters or confirms |
| Quellensteuer tariff code | looks up the amount in the tariff file | – | enters the code from the employee's declaration. Code refuses a run without it for a person marked `taxAtSource` |
| Family allowance claim | adds it to the payslip once confirmed | – | enters what the fund confirmed |
| Each run | computes it, makes the payslip and the entries, matches the payment | explains a figure when asked («wieso isch de Lohn tüüfer?») | releases it (`Freigeben`), and only then is anything booked |
| Corrections | a correction run in the next open month, never a change of a released run | – | asks for it |
| GAV rules (minimum by age or class, Parifonds deduction, 13th mandatory) | executes them as data | drafts them into `knowledge/rules/payroll.guide.yaml` from the GAV text with the person | keeps them |

«Possible without the AI»: every AI row has a form. B0 and B1 work entirely without an AI.

### 6.4 App vs. workspace (ADR 0015)

| In the app | In the workspace |
|---|---|
| The payroll engine (src/payroll/, generic: contributions as kinds from data, no Swiss name in code; the layers lint, tests/layers.test.ts, refuses AHV or BVG outside modules/ch) | The firm's plan: its compensation fund, FAK rate, admin cost, pension fund plan, insurers' rates, each with its source document (`payroll.json`, §7) |
| `modules/ch/payroll.yaml`: the kinds (AHV/IV/EO, ALV, BVG, UVG-BU, UVG-NBU, KTG, FAK, QST), who pays what by law, which wage each applies to, the Lohnausweis field each feeds, payslip labels de/fr/it/en | GAV rules of one branch (painters, joiners): `knowledge/rules/payroll.guide.yaml`, written by the AI with the person |
| `modules/ch/payroll/<year>.yaml`: federal figures with sources | A cantonal FAK amount above the federal minimum (the canton's figure, kept by the firm with its fund's letter) |
| The fetch of tariff files and the tariff lookup (a documented public format) | Which canton's tariff, and the employees' codes |
| Invariants: a released run is immutable, closed periods, the write door (`update(books, moduleActor('payroll'), …)`), seals | The fund's or insurer's portal and its upload format (a source the AI writes, ADR 0014) |
| Payslip and Lohnausweis PDF layout (one base layout, like src/invoices/pdf.ts) | The firm's letterhead (the invoice layout's logo reused) |
| The base errors: missing rate, missing tariff code, a wage under a known minimum, the BVG threshold crossed mid-year, the ALV ceiling reached | – |

No branch for one fund, insurer, canton or payroll vendor in src/. A canton's specifics (Bezugsprovision,
the annual vs monthly Quellensteuer model, the FAK minimum) are rows of `modules/ch/payroll/<year>.yaml`
keyed by canton, as data.

### 6.5 A run

1. **Draft** (code): for the month, per active employee: the last run's figures with this month's
   changes. A run's lines: gross parts (wage, hours × rate, holiday surcharge, 13th share, bonus),
   allowances, deductions per kind (rate × the base that kind applies to, with ceilings
   cumulated over the year), expenses, net. Employer contributions per kind. Every line carries
   `{ kind, base, rate, source }`.
2. **Check** (code): the base errors above. Each is a task in the run's detail, said plainly.
3. **Release** (person): `Freigeben`. The run becomes immutable (like an issued invoice,
   src/invoices/events.ts). At release:
   - the payslip PDF per employee goes into `transactional-data/<year>/receipts/` as a receipt of
     kind `payslip`, linked to the run (so level A's code reads it the same way, and `fundShare`
     can take its deductions from the run directly instead of from text);
   - the entries are booked per employee on the payday by ref `LR-<yyyy>-<mm>-<employeeId>`:
     D 5000 / C 2290 «Lohnverbindlichkeiten» (net, a new account; see Q12), D 5000 / C 2270
     (social deductions), D 5000 / C 2279 (QST), D 2270 / C 2290 (allowances paid through), D
     57xx / C 2270 (the employer's contributions accrued per kind, so 2270 holds the whole debt
     to each fund). Stamped `by: { kind: 'code', check: 'payroll' }`, `run: <runId>`;
   - the bank payment of the net is later matched by code (amount + employee name/IBAN) and books
     D 2290 / C bank.
4. **Funds:** the Akonto and final bills are paid against 2270 only, since the expense was
   accrued in the run. The fund reconciliation per kind: accrued by runs − paid = open, shown on
   the Löhne area per fund. The final statement's difference is booked by code once its bill is
   linked: D/C 57xx against 2270 (the difference between the Akonto basis and the real wage
   sum).
5. **Correction:** a released run with a mistake gets a correction run in the next open month
   (lines «Korrektur Juli», with `corrects: <runId>`). Never an edit, and never in a closed
   period (golden rule 1 applies by analogy: payroll carries no VAT, but the books are sealed
   per quarter).

Accruing the employer's share in the run (step 3) differs from level A, where it is expensed at
payment. Both are correct. The run's way gives monthly expense and a 2270 that matches the funds.
A firm switching from A to B mid-year must not book the share twice: code refuses a contribution
payment's employer line on 57xx for a period whose runs accrued it, and books it against 2270
instead.

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
  with the ESTV's source date). Without the file, the run waits and says «Tarif <canton> <year>
  fehlt». It never guesses.
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
  `JournalEntry.run` already exists. That makes **books schema 10** with an empty migration step. **Owner
  decides** (AGENTS.md «Versions and data format»).
- Refs `LR-…` (runs), `LJ-…` (journal import): new ref prefixes. Check `transactionRef` consumers
  that assume a bank ref or `M`/`RE`/`GS`. No schema change if refs are free text, which they
  appear to be.
- Accounts: 2290 Lohnverbindlichkeiten (B only), a Bezugsprovision account (A4). Chart additions
  in modules/ch/accounts.yaml, added to a workspace's accounts.json by the setup (src/workspace/scaffold.ts).

### 7.2 A new store: `payroll.json` (B only)

Beside `invoices.json` (LAYOUT top, owner `app`), with its own `PAYROLL_SCHEMA = 1` and ladder in
src/workspace/schema.ts. The manifest stays unchanged (no `WORKSPACE_SCHEMA` step), because payroll's
setup lives in its own store. **Owner decides** between this and a `company.payroll` manifest
section (Q6).

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
// Per year: transactional-data/<year>/payroll/runs.jsonl — one released run per line, immutable:
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
  copy. Recommended: plain in the workspace, with access controlled at the repository, and said
  so in setup («Wer die Buchhaltung öffnet, sieht die Löhne»). Owner decides (Q4).
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
  field 8; 2270 = accrued − paid per kind; a released run never changes (books-store write door).
- **Period lock:** a row in tests/period-lock.test.ts for every new route that writes
  (`POST /api/payroll/runs/:id/release`, corrections). A run dated in a closed period is refused.
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

| Phase | Content | Rough effort | Acceptance (scored) |
|---|---|---|---|
| **A-1** | A1 payslip kind, A2 `readPayslip`, A3 code books the gross wage, A9 (#383, #359). Books schema 10 if the owner agrees | 2–3 weeks | §5.4 checks 1–3 pass with the AI **off**. withheld-*.test.ts stay green. Demo books regenerated with payslip PDFs, no figure change |
| **A-2** | A4 Quellensteuer on 2279, A5 `collects:` for pension/accident/sickness, A8 masking | 1–2 weeks | webshop walk: the pension fund's payment clears exactly the BVG share once its file is kept. A payslip with QST books 2279. No `756.` in any prompt (test) |
| **A-3** | A7 year-close payroll checks and Lohnausweis data CSV; A6 payroll journal import (contract + test reference) | 2–3 weeks | §5.4 checks 4–5. Year close of demo-consulting shows 0 differences, and a broken payslip shows its CHF 10 |
| **B0** | ADR 0011 step 2: owner only. `payroll.json`, `modules/ch/payroll{,/2026}.yaml`, the Löhne area, Firma › Löhne, run → PDF → entries → payment match, fund reconciliation, year totals | 4–6 weeks | consulting walk: salary set up in < 5 min from the fund's certificate (AI proposes, he keeps). July run figures = golden case 1 to the Rappen. The bank's net matched by code. 2270 per fund = 0 after the Q3 bills. Without an AI the same by forms |
| **B1** | staff, hourly, 13th, entry/exit, thresholds, allowances, VAV, Lohnausweis PDF, payslip mail | 6–10 weeks | webshop walk: Jana's hourly run with surcharge, no BVG with the reason shown. Huber walk: «mach d Lohnabrechnig für Marco» opens the run and books it after release. Golden payroll set green. Lohnausweis field 8 = Σ runs |
| **B2** | Quellensteuer | 4–8 weeks per first canton, then data | new persona (cross-border from DE): tariff file fetched, run waits without it, settlement list = Σ runs, Bezugsprovision booked |
| **B3** | Treuhänder multi-firm, export for ELM software | open | Treuhänder walk |

The efforts are one developer's estimates with agents doing the programming, before review and
persona rounds.

---

## 13. Open questions for the owner

Each with a recommendation.

1. **Start with A or B?** *Recommendation: A first (A-1 and A-2, about a month).* Every persona and
   every firm with a payroll provider lands its wages through payslips today. The #426–#489 chain
   still leaves the wage line itself to the model. A-1 makes wages work without an AI (#359), and
   B builds on A's payslip kind and `fundShare` anyway.
2. **Which persona first?** *Recommendation: consulting (Matthias) for A-1 and B0; webshop (Corinne
   + Jana) for B1.* Consulting is exactly ADR 0011's scope and has the payslip texts in tests
   already. The webshop adds the smallest real staff case (part-time below the BVG threshold).
   Huber needs payslips in her persona files before A helps her.
3. **Amend ADR 0011 to allow B1 (staff) and B2 (Quellensteuer)?** *Recommendation: amend for B1
   after B0 ships and a persona round scores it. Keep B2 and ELM out until a firm asks.* The
   liability argument of ADR 0011 still holds for Quellensteuer.
4. **Where do salary data live, and who sees them?** *Recommendation: in the workspace, plain,
   versioned. Setup says that whoever opens the books sees the wages. AHV numbers never go to the
   model.* Encryption would break the audit trail and git.
5. **Books schema 10 for `by.check: 'payslip' | 'payrollJournal' | 'payroll'`?** *Recommendation:
   yes, one step for all three, with A-1.*
6. **Payroll settings in a new `payroll.json` (own schema) or in the manifest (`company.payroll`,
   workspace schema 5)?** *Recommendation: `payroll.json`*, like invoices.json. The manifest stays
   small, and payroll's schema can move without migrating every workspace.
7. **Federal rates maintained by the app, company rates from documents?** *Recommendation: yes, as
   ADR 0011 says.* `modules/ch/payroll/<year>.yaml` with sources. A test fails when the next year's
   file is missing once a run is dated in it.
8. **Lohnausweis: own Form 11 PDF or data for eLohnausweis SSK?** *Recommendation: A-3 delivers the
   field-by-field data (CSV + a page). B1 prints Form 11 once it is verified that software-printed
   forms are accepted under the current Wegleitung.* Whether the SSK tool imports a file was not
   verified.
9. **Accrue the employer's contributions in each run (B), or expense them on payment (A, today)?**
   *Recommendation: accrue in B (monthly expense, 2270 matches the funds), keep A as it is, and
   refuse double expensing when a firm switches mid-year.*
10. **Family allowances paid through the wage: which account?** *Recommendation: D 2270 (the fund
    owes them back and nets them on its bill) for A3 and B, with a precedent in booking.guide.yaml.*
    Some Treuhänder use a separate receivable. A firm rule can override.
11. **Payment file (pain.001) for wages?** *Recommendation: not in payroll. If the invoicing or
    payments spec builds a pain.001 channel, payroll hands it the net amounts.* Until then the person
    pays in e-banking, and code matches the bank line to the run.
12. **New account 2290 «Lohnverbindlichkeiten» for B's net between release and payment?**
    *Recommendation: yes, in modules/ch/accounts.yaml.* It makes a released but unpaid run visible
    at a quarter end. Level A keeps booking the net against the bank.
13. **Rounding of payslip amounts to 5 Rappen?** No law found that requires it. Common practice
    rounds each deduction to 0.05. *Recommendation: round to 0.05 per line, as data in
    `modules/ch/payroll.yaml`, so a firm can switch it.*
14. **Disclaimer wording on every payslip and run:** ADR 0011 wants «a calculation from the entered
    rates, to be checked by the Treuhänder». *Recommendation: on the run's detail and in the
    payslip's footer in small print, not as a dialog.*

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
