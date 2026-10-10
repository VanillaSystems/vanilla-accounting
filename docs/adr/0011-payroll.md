# ADR 0011: Payroll: book what others calculate, and a narrow helper for the owner's salary

Status: accepted (2026-10-10). Step 1 exists; steps 2 and 3 are not built.

## Problem

Small companies with staff must run payroll, and a company leaving an all-in-one tool asks
whether this app does it too. Swiss payroll is far more than a calculation:

- deductions for AHV/IV/EO, ALV, the occupational pension (BVG, by the fund's plan), accident
  insurance (BU/NBU) and sick-pay insurance, with employer shares;
- withholding tax (Quellensteuer) for foreign employees, by cantonal tariffs;
- payslips, the annual wage statement (Lohnausweis), annual declarations to the compensation
  office and the insurers;
- electronic wage reporting by the Swissdec standard (ELM). As far as found when writing it is
  not mandatory: wage statements may still be printed, and a company without payroll software
  can make them with the federal tax administration's free tool "eLohnausweis SSK". Reporting
  electronically to the compensation office, SUVA, insurers and tax offices needs payroll
  software certified by Swissdec; more than a hundred such programs exist.

A wrong deduction touches employees, social insurances and taxes directly, which is a larger
liability for free software than a VAT figure the owner checks before filing.

## Decision

Three steps; only the first two belong in this app.

### 1. Book payroll that others calculate (exists)

Employees' payroll stays with a payroll provider, a payroll program or the Treuhänder. The app
books what they deliver: salaries, social insurance payments (AHV akonto and final, BVG, UVG,
KTG) from their documents and the bank lines, as today
([getting-started.md](../getting-started.md)).

### 2. A helper for the owner's salary

The most common case among the companies this app serves is a GmbH or AG in which only the owner
draws a salary. For exactly that case:

| In | Not in |
|---|---|
| one person, the owner, resident in Switzerland | employees other than the owner |
| a fixed monthly salary | hourly or variable pay, overtime, holidays |
| deductions and employer shares from rates the company enters, taken from its compensation office, pension fund and insurers | withholding tax (Quellensteuer) |
| the payslip as PDF | Swissdec electronic reporting |
| the monthly bookings (salary, deductions, employer shares) | several cantons, cross-border staff |
| the yearly totals for the wage statement, ready for "eLohnausweis SSK" | the declarations themselves |
| reminders: akonto against the final AHV statement, the wage statement in January | |

- **The rates are the company's input, not the app's assumption.** Each comes from a document the
  company has (the compensation office's confirmation, the pension fund's certificate, the
  insurance policy), entered once a year; the app shows where each is from. Federal rates that
  apply to everyone (AHV/IV/EO, ALV and its ceiling) are offered as defaults per year, maintained
  in the app with their source, and can be overridden.
- **Every result says what it is:** a calculation from the entered rates, to be checked by the
  Treuhänder, not payroll advice. The year-end checklist already asks for the final AHV, BVG and
  UVG statements against the advance payments.
- **Refuse what is out of scope** with a reason ("Quellensteuer wird nicht berechnet; dafür einen
  Lohnanbieter verwenden"), as the setup refuses unsupported VAT methods.

### 3. Full payroll: a product of its own, later, or never

Payroll for employees (several people, withholding tax, variable pay, Swissdec reporting) would be
a separate product, built only if demand justifies Swissdec certification and the liability that
comes with paying other people's salaries. It would deliver its bookings into the books the way
a payroll provider does today (step 1).

## Consequences

- A payroll settings record per year (the owner's salary, rates with their sources) and a
  monthly payroll run for the owner, producing the payslip and the entries through the command
  registry ([ADR 0005](0005-agents-command-registry-cli-mcp.md)).
- Yearly default federal rates maintained in the app, each with its source and year.
- Wage statement data exported for the free federal tool; the app does not produce the official
  form itself.

## Rejected

- **Full payroll in this app now:** withholding tax, variable pay and Swissdec certification are a
  product of their own, with a liability toward employees the books do not carry.
- **Swissdec certification for the owner's salary:** electronic reporting is optional, and a
  single owner's statement is made with the free federal tool.
- **Hard-coded rates:** pension, accident and sick-pay rates differ by company; a wrong assumed
  rate is worse than asking.
