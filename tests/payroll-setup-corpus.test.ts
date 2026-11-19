/**
 * Fund's and insurer's documents against their bills (docs/specs/payroll.md §22 decision 108, second review of walk 3): a
 * corpus of realistic texts in German, French and Italian, each told apart by its title and whether it says to pay, never
 * by a product name or a total. Every text is invented.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSetupText, setupFileName } from '../src/payroll/setup-documents.js';
import { ch } from './support/payroll.js';
import { documents } from '../src/engines/index.js';

const D: Record<string, string[]> = {
  // --- real setup documents (should be true)
  'de cert, Total Beiträge': ['Vorsorgestiftung Beispiel', 'Vorsorgeausweis per 1.1.2026', 'Vertragsnummer: V-77', 'Versicherte Person: Mila Beispiel', 'Geburtsdatum 12.05.1980', "Gemeldeter Jahreslohn 92'000.00", "Versicherter Lohn 66'280.00", 'Sparbeitrag Arbeitnehmer pro Monat 250.00', 'Risikobeitrag Arbeitnehmer pro Monat 50.00', 'Total Beitrag Arbeitnehmer pro Monat 300.00', 'Total Beitrag Arbeitgeber pro Monat 300.00', "Altersguthaben am 1.1.2026 45'300.00"],
  'de cert, Total Altersguthaben far down': ['Vorsorgestiftung Beispiel', 'Vorsorgeausweis per 1.1.2026', 'Vertragsnummer: V-77', 'Versicherte Person: Mila Beispiel', "Versicherter Lohn 66'280.00", 'Beitrag Arbeitnehmer pro Monat 300.00', 'Beitrag Arbeitgeber pro Monat 300.00', 'Altersleistungen', "Voraussichtliches Altersguthaben mit 65 412'000.00", 'Invalidenrente pro Jahr 26\'512.00', 'Freizügigkeitsleistung', "Total 45'300.00"],
  'de cert, Altersgutschrift in head': ['Vorsorgestiftung Beispiel', 'Persönlicher Ausweis gültig ab 1.1.2026', 'Versicherte Person: Mila Beispiel', "Versicherter Lohn 66'280.00", 'Altersgutschrift 10 %', 'Beitrag Arbeitnehmer pro Monat 300.00'],
  'de cert, Summe': ['Vorsorgestiftung Beispiel', 'Vorsorgeausweis per 1.1.2026', 'Versicherte Person: Mila Beispiel', "Versicherter Lohn 66'280.00", 'Beitrag Arbeitnehmer pro Monat 300.00', 'Beitrag Arbeitgeber pro Monat 300.00', 'Summe der Beiträge pro Monat 600.00'],
  'fr cert': ['Fondation de prévoyance Exemple', 'Certificat de prévoyance au 1.1.2026', 'N° de contrat: V-77', 'Personne assurée: Mila Exemple', "Salaire assuré 66'280.00", 'Cotisation employé par mois 300.00', 'Cotisation employeur par mois 300.00', 'Total des cotisations 600.00'],
  'it cert': ['Fondazione di previdenza Esempio', 'Certificato di previdenza al 1.1.2026', 'N. contratto: V-77', 'Persona assicurata: Mila Esempio', "Salario assicurato 66'280.00", 'Contributo dipendente al mese 300.00', 'Contributo datore di lavoro al mese 300.00', 'Totale contributi 600.00'],
  'de Akontoverfügung, zahlbar bis': ['Ausgleichskasse Beispiel', 'Bahnhofstrasse 1, 6300 Zug', 'Verfügung über die Akontobeiträge 2026', 'Abrechnungsnummer: 100.2345', "Massgebende Lohnsumme CHF 120'000.00", 'Verwaltungskosten 2.5 % der AHV/IV/EO-Beiträge', "Akontobeitrag pro Quartal CHF 4'560.00", 'Die Akontobeiträge sind zahlbar bis zum 10. Tag nach Ablauf des Quartals.', 'Rechtsmittelbelehrung: Einsprache innert 30 Tagen'],
  'de Beitragsverfügung, Total pro Quartal': ['Ausgleichskasse Beispiel', 'Beitragsverfügung 2026', 'Abrechnungsnummer: 100.2345', 'AHV/IV/EO 10.6 %', 'ALV 2.2 %', 'Familienausgleichskasse FAK 1.6 %', 'Verwaltungskosten 2.5 %', "Total Akontobeiträge pro Quartal CHF 4'560.00"],
  'de Beitragsverfügung, Fälligkeit': ['Ausgleichskasse Beispiel', 'Beitragsverfügung 2026', 'Abrechnungsnummer: 100.2345', 'Verwaltungskosten 2.5 %', 'Fälligkeit: jeweils am 10. des Folgemonats'],
  'fr décision': ['Caisse de compensation Exemple', 'Décision de cotisations d\'acomptes 2026', "N° d'affilié: 100.2345", "Masse salariale CHF 120'000.00", "Frais d'administration 2.5 %", "Total par trimestre CHF 4'560.00"],
  'it decisione, scadenza': ['Cassa di compensazione Esempio', "Decisione sui contributi d'acconto 2026", 'N. affiliato: 100.2345', 'Spese amministrative 2.5 %', 'Scadenza: il 10 del mese successivo'],
  'de UVG-Police, Jahresprämie total': ['Unfallversicherung Beispiel AG', 'UVG-Police 2026', 'Policennummer: UV-55.123', 'Vertragsbeginn 01.01.2026, Vertragsablauf 31.12.2028', 'Berufsunfall BU 0.120 %', 'Nichtberufsunfall NBU 1.350 %', "Provisorische Lohnsumme CHF 148'000.00", "Total Jahresprämie CHF 1'770.00", 'Zahlungsart: jährlich, Fälligkeit 01.01.'],
  'de KTG-Police, Zahlungsfrist': ['Beispiel Versicherungen AG', 'Krankentaggeld-Police', 'Police Nr. 44.555', 'Prämiensatz 1.20 %', 'Wartefrist 30 Tage', 'Zahlungsfrist 30 Tage'],
  'it polizza, Scadenza del contratto': ['Assicurazioni Esempio SA', 'Polizza assicurazione infortuni LAINF', 'N. polizza: UV-55.123', 'Inizio 01.01.2026', 'Scadenza 31.12.2028', 'INP 0.120 %', 'Infortuni non professionali 1.350 %'],
  'fr police, total prime': ["Assurances Exemple SA", "Police d'assurance-accidents LAA", 'N° de police: UV-55.123', 'AP 0.120 %', 'ANP 1.350 %', "Prime annuelle totale CHF 1'770.00", "Total CHF 1'770.00"],
  // --- bills (should be false)
  'BILL Prämienabrechnung LSV, no slip': ['Beispiel Versicherungen AG', 'Kollektiv-Krankentaggeldversicherung', 'Police Nr. 44.555', 'Prämienabrechnung 2026', 'Datum: 01.07.2026', "Prämie 01.01.2026 - 31.12.2026 CHF 1'250.00", 'Der Betrag wird am 31.07.2026 Ihrem Konto belastet (LSV).'],
  'BILL Definitive Prämienabrechnung, zu bezahlender Betrag': ['Unfall Beispiel AG', 'Unfallversicherung nach UVG', 'Definitive Prämienabrechnung 2025', 'Police Nr. UV-55.123', "Definitive Lohnsumme CHF 151'200.00", "Zu bezahlender Betrag CHF 212.40", 'Bitte überweisen Sie den Betrag bis 31.03.2026.'],
  'BILL fr décompte de primes': ['Assurances Exemple SA', 'Assurance-accidents LAA', 'Décompte de primes 2026', 'N° de police: UV-55.123', "Prime 2026 CHF 1'770.00", 'Montant à régler jusqu\'au 31.01.2026'],
  'BILL it conteggio premi': ['Assicurazioni Esempio SA', 'Assicurazione infortuni LAINF', 'Conteggio dei premi 2026', 'N. polizza: UV-55.123', "Premio 2026 CHF 1'770.00", 'Da pagare entro il 31.01.2026'],
  'BILL QR': ['Beispiel Versicherungen AG', 'Krankentaggeldversicherung', 'Prämienabrechnung 2026', "Prämie CHF 1'250.00", 'Empfangsschein', 'Zahlteil', 'Konto / Zahlbar an'],
};
// The walk's own documents and the bills of the first review.
D['walk decision'] = ['Ausgleichskasse Beispiel', 'Bahnhofstrasse 1, 6300 Zug', 'Beitragsverfügung 2026', 'Abrechnungsnummer: 100.2345', 'Verwaltungskosten 2.5 % der AHV/IV/EO-Beiträge', 'Familienausgleichskasse FAK 1.6 %', "Akontobeiträge auf der Lohnsumme CHF 120'000.00", 'Datum: 05.01.2026'];
D['walk policy'] = ['Unfallversicherung Beispiel AG', 'UVG-Police 2026', 'Policennummer: UV-55.123', 'Berufsunfall BU 0.120 %', 'Nichtberufsunfall NBU 1.350 %', "Prämie pro Jahr CHF 1'770.00"];
D['walk certificate'] = ['Pensionskasse Zentral', 'Vorsorgeausweis per 1.1.2026', 'Vertragsnummer: PK-1180', 'Versicherte Person: Corinne Wyss', 'Geburtsdatum 12.05.1980', "Versicherter Lohn CHF 61'100.00", 'Beitrag Arbeitnehmer pro Monat 199.20', 'Beitrag Arbeitgeber pro Monat 199.20'];
D['BILL Beitragsrechnung'] = ['Vorsorgestiftung Beispiel', 'Beitragsrechnung Q3 2026 PK-26-3-1180', 'Datum: 01.07.2026', 'Teegarten Wyss GmbH', 'Beiträge gemäss Vorsorgeausweis 2026', "Total CHF 1'800.00", 'Zahlbar bis 31.07.2026'];
D['BILL Prämienrechnung'] = ['Beispiel Versicherungen AG', 'Kollektiv-Krankentaggeldversicherung', 'Police Nr. 44.555', 'Prämienrechnung 2026', 'Datum: 01.07.2026', 'Teegarten Wyss GmbH', "Total CHF 1'250.00", 'Zahlbar bis 31.07.2026'];
D['BILL Rechnung Nr.'] = ['Unfall Beispiel AG', 'Unfallversicherung nach UVG', 'Rechnung Nr. 2026-771', 'Datum: 02.07.2026', "Prämie 2026 Total CHF 1'770.00", 'Zahlbar bis 31.07.2026'];
D['BILL Akonto with its decision'] = ['Ausgleichskasse Beispiel', 'Akontobeiträge 3. Quartal 2026', 'Gestützt auf die Beitragsverfügung vom 12.01.2026', 'Rechnung Nr. 5512', 'Datum: 03.07.2026', "Total CHF 2'400.00", 'Zahlbar bis 10.08.2026'];

test('decision 108: every fund\'s document of the corpus is one, every bill a receipt', () => {
  const wrong = Object.entries(D).filter(([k, l]) => isSetupText(l.join('\n'), ch.payroll!, documents()) === k.startsWith('BILL')).map(([k]) => k);
  assert.deepEqual(wrong, [], 'told wrong');
  assert.equal(Object.keys(D).length, 27);
});

test('decision 108: a picture named as a fund\'s document is not read by a model\'s vision', () => {
  assert.ok(setupFileName('Vorsorgeausweis_Wyss_2026.jpg', ch.payroll!));
  assert.ok(setupFileName('UVG-Police.png', ch.payroll!));
  assert.ok(!setupFileName('Lohnausweis_2025.jpg', ch.payroll!));
  assert.ok(!setupFileName('IMG_2041.jpg', ch.payroll!));
});
