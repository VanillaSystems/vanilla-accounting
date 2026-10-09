# Translations to review

The French, Italian and English texts in `src/app/i18n/locales/` were written without a native
speaker or a Treuhänder. This list names the terms a reviewer should check first. Fix a term in
the locale file and run `npm test`.

## ESTV form wording (MWST tab and form 0535)

The Ziffer labels (`vat.z…` for the return, `form0535.z…` for the correction return) follow the
ESTV forms 0550/0535 as far as the translator remembers them. Compare each against the ESTV's
current French and Italian form before a filing relies on it.

| Key | fr | it | Unsure about |
|---|---|---|---|
| `vat.z200`, `form0535.z200` | Total des contre-prestations convenues ou reçues | Totale delle controprestazioni convenute o ricevute | the form's full text is longer (opted supplies, notification procedure, supplies abroad) |
| `vat.z205`, `form0535.z205` | Contre-prestations … pour lesquelles il a été opté | … per le quali si è optato | abbreviated |
| `vat.z220` | Prestations exonérées | Prestazioni esenti dall'imposta | the form also names supplies to beneficiary institutions (art. 107) |
| `vat.z225` | Transferts avec la procédure de déclaration | Trasferimenti mediante procedura di notifica | the form mentions form 764 |
| `vat.z230` | Prestations exclues du champ de l'impôt | Prestazioni escluse dall'imposta | |
| `vat.z235` | Diminutions de la contre-prestation | Diminuzioni della controprestazione | |
| `vat.z299` | Chiffre d'affaires imposable | Cifra d'affari imponibile complessiva | fr may be "Total du chiffre d'affaires imposable" |
| `vat.z400`, `vat.z405` | Impôt préalable grevant … | Imposta precedente su … | |
| `vat.z410` | Dégrèvement ultérieur de l'impôt préalable | Sgravio fiscale successivo | |
| `vat.z415` | Corrections de l'impôt préalable | Correzioni dell'imposta precedente | "double affectation", "prestations à soi-même" in the 0535 line |
| `vat.z420` | Réductions de la déduction de l'impôt préalable | Riduzioni della deduzione dell'imposta precedente | |
| `vat.z510` | Solde en faveur de l'assujetti | Credito a favore del contribuente | |
| `vat.z900`, `vat.z910` | Subventions … / Dons, dividendes … | Sussidi … / Doni, dividendi … | abbreviated |
| `vat.sectionOtherFlows` | Autres flux de fonds (art. 18, al. 2) | Altri flussi di mezzi finanziari (art. 18 cpv. 2) | |
| `vat.rateAccommodation` | Taux spécial pour l'hébergement | Aliquota speciale per l'alloggio | |
| `vat.rateAcquisition` | Impôt sur les acquisitions | Imposta sull'acquisto | |
| `vat.colZiffer` | Chiffre | Cifra | the form's column name |
| `form0535.title`, `vat.viewCorrection` | Décompte rectificatif | Rendiconto di correzione | the ESTV's own name for form 0535 |
| `vat.adjustment` | Déclaration complémentaire | Dichiarazione complementare | German "Nachdeklaration" |
| `vat.title` | Décompte TVA | Rendiconto IVA | |

English has no ESTV form. Its labels describe the boxes (`Box 200`); a reader who files in
English still enters the figures on the German, French or Italian form.

## Bookkeeping terms

| German | fr | it | en | Unsure about |
|---|---|---|---|---|
| Beleg | justificatif | giustificativo | receipt | fr "pièce justificative" is the full form |
| Buchung | écriture | registrazione | entry | |
| Klassifizieren (AI books a transaction) | Comptabiliser | Contabilizza | Book | |
| Auslage (expense paid privately) | débours | spesa anticipata | expense paid privately | fr "débours" may read as "disbursement for a client"; "frais avancés" is an alternative |
| Saldobilanz | Balance de vérification | Bilancio di verifica | Trial balance | |
| Kontoauszug (tab: one account's ledger) | Extrait de compte | Scheda conto | Account ledger | fr is the same word as the bank statement |
| Kontoauszüge (bank PDFs) | Extraits bancaires | Estratti bancari | Bank statements | |
| Kontenabgleich | Rapprochement bancaire | Riconciliazione bancaria | Bank reconciliation | |
| Umlaufvermögen / Anlagevermögen | Actif circulant / Actif immobilisé | Attivo circolante / Attivo fisso | Current / fixed assets | |
| Fremdkapital | Capitaux étrangers | Capitale di terzi | liabilities | |
| Nebenbetrieblicher Ertrag/Aufwand | Produits/charges hors exploitation | Ricavi/costi accessori | Non-operating income/expenses | it may be "Ricavi/costi estranei all'esercizio" |
| Betriebsergebnis | Résultat d'exploitation | Risultato d'esercizio operativo | Operating result | it may be just "Risultato operativo" |
| Prüfmodus (audit bar) | Mode révision | Modalità revisione | Audit mode | |
| Gutschrift / Belastung | Crédit / Débit | Accredito / Addebito | Credit / Debit | |
| Gebühr (Wise fee) | Frais | Commissione | Fee | |
| MWST-Nr | No TVA | N. IVA | VAT no. | |

## VAT codes explained (`vatCodes.*`)

The code list (MWST tab, **Codes erklärt**) explains each kind of code in plain words and cites
the law. The French and Italian name the law LTVA/LIVA and its articles "art. 8, al. 1" and
"art. 8 cpv. 1". Check these terms first:

| Key | fr | it | Unsure about |
|---|---|---|---|
| `vatCodes.kind.depositRelief.name` | Dégrèvement ultérieur de l’impôt préalable | Sgravio fiscale successivo | the ESTV's term for Einlageentsteuerung |
| `vatCodes.kind.inputCorrection.name` | Correction de l’impôt préalable (part privée, prestation à soi-même) | Correzione dell’imposta precedente (quota privata, consumo proprio) | "consumo proprio" for Eigenverbrauch |
| `vatCodes.kind.notification.name` | Transfert avec la procédure de déclaration | Trasferimento mediante procedura di notifica | |
| `vatCodes.kind.flatRate.name`, `vatCodes.family.F` | Taux de la dette fiscale nette | Aliquota saldo | it may be "aliquote saldo" (plural, the method) |
| `vatCodes.kind.taxCredit.name` | Imputation de l’impôt selon le formulaire 1050 ou 1055 | Computo dell’imposta secondo il modulo 1050 o 1055 | the forms' own titles |
| `vatCodes.kind.nonConsideration.name`, `vatCodes.family.Z` | Non-contre-prestations | Non controprestazioni | the ESTV's wording for Nicht-Entgelte |
| `vatCodes.kind.subsidies.when` | contributions aux services d’élimination ou des eaux | contributi per lo smaltimento o l’approvvigionamento idrico | Entsorgungs- und Wasserwerkbeiträge |
| `vatCodes.kind.discount.name` | Diminution de la contre-prestation (escompte, rabais) | Diminuzione della controprestazione (sconto, ribasso) | |
| `vatCodes.example` | recueil de cas | raccolta di casi | the casebook's name |

The examples the list shows come from the casebook (`examples/cases/`), whose titles are English
in every language.

## German texts that changed

Moving the texts to `de.ts` changed a few German strings. Check that each still reads well.

- The batch-rename result was English ("Done: … renamed"); it is now German.
- "{n} Abweichung(en)", "{n} Beleg(e)" and similar are now real plurals.
- „kein Beleg nötig" now uses Swiss quotes: «kein Beleg nötig».
- The Buchungen tab's receipt preview had the English title "Receipt preview"; it is now "Belegvorschau".
