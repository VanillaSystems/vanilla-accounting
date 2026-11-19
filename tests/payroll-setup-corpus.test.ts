/**
 * Fund's and insurer's documents against their bills (docs/specs/payroll.md §22 decision 108, second review of walk 3): a
 * corpus of realistic texts in German, French and Italian, each told apart (as a suggestion the person answers) by its title and whether it says to pay, never
 * by a product name or a total. Every text is invented.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSetupText } from '../src/payroll/setup-documents.js';
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
// The second review's corpus: setup documents behind an address block, titled «Police Nr.», with dates; bills in each language.
Object.assign(D, {
  // DE setup
  'de cert behind an address block': ['Sammelstiftung BVG Beispiel Leben', 'Postfach, 8022 Zürich', 'Teegarten Wyss GmbH', 'Frau Corinne Wyss', 'Teegasse 1', '6300 Zug', 'Zürich, 15.01.2026', 'Vorsorgeausweis gültig ab 01.01.2026', 'Versicherte Person: Corinne Wyss', "Versicherter Lohn 61'100.00", 'Beitrag Arbeitnehmer pro Monat 199.20'],
  'de policy titled Police Nr.': ['Beispiel Versicherungen AG', 'Police Nr. 15.123.456', 'Kollektiv-Krankentaggeldversicherung nach VVG', 'Versicherungsnehmer: Teegarten Wyss GmbH', 'Beginn 01.01.2026, Ablauf 31.12.2028', 'Prämiensatz 1.20 % der Lohnsumme', 'Wartefrist 30 Tage'],
  'de cert title with colon': ['Pensionskasse Zentral', 'Vorsorgeausweis: Stand 01.01.2026', 'Versicherte Person: Corinne Wyss', "Versicherter Lohn 61'100.00", 'Beitrag Arbeitnehmer pro Monat 199.20'],
  'de cert title with contract no. on its line': ['Pensionskasse Zentral', 'Vorsorgeausweis per 01.01.2026   Vertrag Nr. 1180', 'Versicherte Person: Corinne Wyss', "Versicherter Lohn 61'100.00"],
  'de Suva Einreihungsverfügung': ['Suva', 'Einreihungsverfügung 2026', 'Unfallversicherung nach UVG', 'Kunden-Nr. 123-4567.8', 'Berufsunfall Nettoprämiensatz 0.4800 %', 'Nichtberufsunfall Nettoprämiensatz 1.2900 %', 'Rechtsmittelbelehrung'],
  'de policy, premium payable each year': ['Unfallversicherung Beispiel AG', 'UVG-Police 2026', 'Policennummer: UV-55.123', 'BU 0.120 %', 'NBU 1.350 %', "Jahresprämie CHF 1'770.00", 'Die Prämie ist jährlich im Voraus zahlbar bis 31.01.'],
  'de Akontoverfügung with quarterly dates': ['Ausgleichskasse Beispiel', 'Akontoverfügung 2026', 'Abrechnungsnummer: 100.2345', "Akontobeitrag pro Quartal CHF 4'560.00", 'Zahlbar bis: 10.04.2026, 10.07.2026, 10.10.2026, 10.01.2027', 'Rechtsmittelbelehrung'],
  'de Versicherungsausweis lower': ['Stiftung Auffangeinrichtung BVG', 'Versicherungsausweis 2026', 'Arbeitgeber Teegarten Wyss GmbH', 'Name Wyss Corinne', "Koordinierter Lohn 34'640.00", 'Sparbeitrag AN 144.35', 'Risikobeitrag AN 28.85'],
  'de UVG-Zusatz Police': ['Beispiel Versicherungen AG', 'Versicherungspolice', 'UVG-Zusatzversicherung', 'Police-Nr. 77.001', 'Prämiensatz Männer 0.21 %', 'Prämiensatz Frauen 0.34 %'],
  'de Beitragsverfügung with Rechnungsjahr': ['Ausgleichskasse Beispiel', 'Beitragsverfügung für das Rechnungsjahr 2026', 'Abrechnungsnummer: 100.2345', 'AHV/IV/EO 10.6 %', 'Verwaltungskosten 2.5 %'],
  // DE bills
  'BILL de Verfügung that is the quarterly bill, Fällig am': ['Ausgleichskasse Beispiel', 'Akontoverfügung 3. Quartal 2026', 'Abrechnungsnummer: 100.2345', "AHV/IV/EO-Beiträge CHF 3'180.00", "ALV-Beiträge CHF 660.00", "Verwaltungskosten CHF 79.50", "Betrag CHF 3'919.50", 'Fällig am 10.10.2026', 'IBAN CH3880808000000000002'],
  'BILL de Abrechnung zur UVG-Police, LSV worded apart': ['Unfall Beispiel AG', 'Definitive Abrechnung 2025 zur UVG-Police', 'Policennummer UV-55.123', "Definitive Lohnsumme CHF 151'200.00", "Saldo zu unseren Gunsten CHF 212.40", 'Der Betrag wird Ihrem Konto am 31.03.2026 belastet.'],
  'BILL de Akontobeitrag ohne Titelwort': ['Ausgleichskasse Beispiel', 'Akontobeitrag 3. Quartal 2026', 'Abrechnungsnummer: 100.2345', "Betrag CHF 3'919.50", 'Fällig am 10.10.2026'],
  'BILL de PK Beitragsfaktura': ['Pensionskasse Zentral', 'Beitragsfaktura Juli 2026', 'Vertragsnummer: PK-1180', 'Beiträge gemäss Vorsorgeausweis', "Total CHF 398.40", 'Zahlbar bis 31.07.2026'],
  'BILL de Kontoauszug PK': ['Pensionskasse Zentral', 'Kontokorrentauszug per 30.06.2026', 'gemäss Versicherungsausweis der Versicherten', "Saldo zu unseren Gunsten CHF 1'195.20", 'Wir bitten um Überweisung bis 31.07.2026'],
  'BILL de Prämie eBill, Police line first': ['Beispiel Versicherungen AG', 'Krankentaggeld-Police', 'Prämie 2. Halbjahr 2026', "Prämie CHF 625.00", 'Die Belastung erfolgt via eBill am 01.07.2026'],
  'BILL de Mahnung': ['Ausgleichskasse Beispiel', 'Mahnung', 'Beitragsverfügung vom 12.01.2026', "Offener Betrag CHF 3'919.50", 'Mahngebühr CHF 30.00', 'Zahlbar innert 10 Tagen'],
  'BILL de Schlussabrechnung': ['Ausgleichskasse Beispiel', 'Schlussabrechnung 2025', 'gemäss Beitragsverfügung', "Differenz zu unseren Gunsten CHF 412.00", 'zahlbar bis 28.02.2026'],
  'BILL de Prämienrechnung far down (address block)': ['Beispiel Versicherungen AG', 'Postfach', '8022 Zürich', 'Teegarten Wyss GmbH', 'Teegasse 1', '6300 Zug', 'Zürich, 01.07.2026', 'Kundennummer 12345', 'Ihr Berater: Hans Muster', 'Telefon 044 000 00 00', 'UVG-Police', 'Unfallversicherung nach UVG', 'Prämienrechnung 2026', "Jahresprämie CHF 1'770.00", 'Zahlung per LSV am 31.07.2026'],
  'BILL de Rechnung für Police Unfallversicherung': ['Unfall Beispiel AG', 'Police Unfallversicherung', 'Ihre Prämie für 2026', "Bruttoprämie CHF 1'770.00", 'Eidg. Stempelabgabe CHF 0.00', "Zu zahlen bis 31.01.2026 CHF 1'770.00"],
  // FR setup
  'fr certificat behind address': ['Fondation collective Exemple', 'Case postale', '1001 Lausanne', 'Jardin de thé Wyss Sàrl', 'Madame Corinne Wyss', 'Lausanne, le 15.01.2026', 'Certificat de prévoyance valable dès le 01.01.2026', 'Personne assurée: Corinne Wyss', "Salaire assuré 61'100.00"],
  'fr certificat d\'assurance': ['Caisse de pensions Exemple', "Certificat d'assurance au 01.01.2026", "Salaire annuel annoncé 86'000.00", "Salaire assuré 60'275.00", 'Cotisation employé par mois 199.20'],
  'fr police LAA': ['Assurances Exemple SA', "Police d'assurance-accidents LAA", 'Preneur d\'assurance: Jardin de thé Wyss Sàrl', 'Accidents professionnels 0.120 %', 'Accidents non professionnels 1.350 %', 'Prime payable annuellement d\'avance'],
  'fr police No on title line': ['Assurances Exemple SA', 'Police n° 15.123.456', "Assurance d'indemnités journalières maladie", 'Taux de prime 1.20 %'],
  'fr décision d\'acomptes': ['Caisse cantonale de compensation', "Décision de cotisations d'acomptes 2026", "N° d'affilié: 100.2345", 'AVS/AI/APG 10.6 %', "Frais d'administration 2.5 %", "Acompte trimestriel CHF 4'560.00", 'payable jusqu\'au 10 du mois suivant le trimestre'],
  'fr décision fixation': ['Caisse de compensation Exemple', 'Décision de fixation des acomptes de cotisations 2026', "N° d'affilié: 100.2345", "Masse salariale CHF 120'000.00"],
  'fr attestation': ['Fondation de prévoyance Exemple', "Attestation d'assurance", 'Certificat de prévoyance', 'Personne assurée: Mila Exemple', "Salaire assuré 66'280.00"],
  'fr police complémentaire': ['Assurances Exemple SA', 'Police', 'Assurance complémentaire LAA', 'Taux hommes 0.21 %', 'Taux femmes 0.34 %'],
  'fr certificat with Date:': ['Fondation de prévoyance Exemple', 'Certificat de prévoyance', 'Date: 01.01.2026', 'Personne assurée: Mila Exemple', "Avoir de vieillesse 45'300.00"],
  'fr décision with échéance dates': ['Caisse de compensation Exemple', "Décision de cotisations d'acomptes 2026", "Acompte CHF 4'560.00", 'Échéances: 10.04.2026, 10.07.2026, 10.10.2026'],
  // FR bills
  'BILL fr facture de cotisations': ['Caisse de compensation Exemple', 'Facture de cotisations 3e trimestre 2026', "selon décision de cotisations d'acomptes", "Total CHF 3'919.50", 'Payable jusqu\'au 10.10.2026'],
  'BILL fr décompte de cotisations': ['Fondation de prévoyance Exemple', 'Décompte de cotisations juillet 2026', 'selon certificat de prévoyance', "Montant CHF 398.40", 'Échéance 31.07.2026'],
  'BILL fr avis de prime': ['Assurances Exemple SA', 'Avis de prime 2026', "Police d'assurance-accidents LAA", "Prime annuelle CHF 1'770.00", 'À payer avant le 31.01.2026'],
  'BILL fr bordereau de prime': ['Assurances Exemple SA', "Police d'assurance-accidents LAA", 'Bordereau de prime 2026', "Prime CHF 1'770.00", 'Échéance: 31.01.2026', 'Prélèvement LSV'],
  'BILL fr rappel': ['Caisse de compensation Exemple', 'Rappel', "Décision de cotisations d'acomptes du 12.01.2026", "Solde CHF 3'919.50", 'Délai de paiement 10 jours'],
  'BILL fr décompte final': ['Assurances Exemple SA', "Décompte final 2025 police d'assurance-accidents LAA", "Solde en notre faveur CHF 212.40", 'Montant débité de votre compte le 31.03.2026'],
  'BILL fr facture QR': ['Assurances Exemple SA', "Assurance d'indemnités journalières", 'Police', "Prime CHF 625.00", 'Récépissé', 'Section paiement'],
  'BILL fr acompte trimestriel': ['Caisse de compensation Exemple', 'Décision', 'Acompte 3e trimestre 2026', "Décision de cotisations", "Montant dû CHF 3'919.50", 'Échéance le 10.10.2026'],
  'BILL fr prime échue': ['Assurances Exemple SA', 'Police', "Assurance-accidents LAA: prime échue", "Prime CHF 1'770.00", 'Veuillez verser ce montant d\'ici au 31.01.2026'],
  'BILL fr note de crédit': ['Assurances Exemple SA', 'Note de crédit', "Police d'assurance-accidents LAA", "Montant en votre faveur CHF 88.00"],
  // IT setup
  'it certificato behind address': ['Fondazione collettiva Esempio', 'Casella postale', '6900 Lugano', 'Giardino del tè Wyss Sagl', 'Signora Corinne Wyss', 'Lugano, 15.01.2026', 'Certificato di previdenza valido dal 01.01.2026', 'Persona assicurata: Corinne Wyss', "Salario assicurato 61'100.00"],
  'it certificato d\'assicurazione': ['Cassa pensioni Esempio', "Certificato d'assicurazione al 01.01.2026", "Salario annuo notificato 86'000.00", 'Contributo dipendente al mese 199.20'],
  'it polizza LAINF': ['Assicurazioni Esempio SA', 'Polizza assicurazione infortuni LAINF', 'Contraente: Giardino del tè Wyss Sagl', 'IP 0.120 %', 'INP 1.350 %'],
  'it polizza n. on title line': ['Assicurazioni Esempio SA', 'Polizza n. 15.123.456', "Assicurazione d'indennità giornaliera di malattia", 'Tasso di premio 1.20 %'],
  'it decisione acconti': ['Cassa cantonale di compensazione', "Decisione sui contributi d'acconto 2026", 'N. affiliato: 100.2345', 'AVS/AI/IPG 10.6 %', "Acconto trimestrale CHF 4'560.00", 'pagabile entro il 10 del mese successivo al trimestre'],
  'it decisione di fissazione': ['Cassa di compensazione Esempio', 'Decisione di fissazione degli acconti 2026', 'Decisione di contributi', "Massa salariale CHF 120'000.00"],
  'it polizza complementare': ['Assicurazioni Esempio SA', 'Polizza', 'Assicurazione complementare LAINF', 'Tasso uomini 0.21 %'],
  'it certificato with Data:': ['Fondazione di previdenza Esempio', 'Certificato di previdenza', 'Data: 01.01.2026', 'Persona assicurata: Mila Esempio', "Avere di vecchiaia 45'300.00"],
  'it certificato personale': ['Fondazione di previdenza Esempio', 'Certificato personale', 'Certificato di previdenza 2026', 'Persona assicurata: Mila Esempio'],
  'it decisione scadenze': ['Cassa di compensazione Esempio', "Decisione sui contributi d'acconto 2026", "Acconto CHF 4'560.00", 'Scadenze: 10.04.2026, 10.07.2026'],
  // IT bills
  'BILL it fattura contributi': ['Cassa di compensazione Esempio', 'Fattura contributi 3° trimestre 2026', "secondo decisione sui contributi d'acconto", "Totale CHF 3'919.50", 'Pagabile entro il 10.10.2026'],
  'BILL it conteggio contributi': ['Fondazione di previdenza Esempio', 'Conteggio dei contributi luglio 2026', 'secondo certificato di previdenza', "Importo CHF 398.40", 'Scadenza 31.07.2026'],
  'BILL it avviso di premio': ['Assicurazioni Esempio SA', 'Avviso di premio 2026', 'Polizza assicurazione infortuni LAINF', "Premio annuo CHF 1'770.00", 'Da versare entro il 31.01.2026'],
  'BILL it polizza poi premio': ['Assicurazioni Esempio SA', 'Polizza assicurazione infortuni LAINF', 'Premio 2026', "Premio CHF 1'770.00", 'Scadenza: 31.01.2026', 'Addebito LSV'],
  'BILL it sollecito': ['Cassa di compensazione Esempio', 'Sollecito', "Decisione sui contributi d'acconto del 12.01.2026", "Saldo CHF 3'919.50", 'Termine di pagamento 10 giorni'],
  'BILL it conteggio finale': ['Assicurazioni Esempio SA', 'Conteggio finale 2025 polizza assicurazione infortuni LAINF', "Saldo a nostro favore CHF 212.40", 'Importo addebitato sul vostro conto il 31.03.2026'],
  'BILL it QR': ['Assicurazioni Esempio SA', "Assicurazione d'indennità giornaliera", 'Polizza', "Premio CHF 625.00", 'Ricevuta', 'Sezione pagamento'],
  'BILL it acconto trimestrale': ['Cassa di compensazione Esempio', 'Decisione', 'Acconto 3° trimestre 2026', 'Decisione di contributi', "Importo dovuto CHF 3'919.50", 'Scadenza il 10.10.2026'],
  'BILL it premio scaduto': ['Assicurazioni Esempio SA', 'Polizza', 'Assicurazione infortuni LAINF: premio scaduto', "Premio CHF 1'770.00", 'Vogliate versare l\'importo entro il 31.01.2026'],
  'BILL it nota di credito': ['Assicurazioni Esempio SA', 'Nota di credito', 'Polizza assicurazione infortuni LAINF', "Importo a vostro favore CHF 88.00"],
});
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
  assert.equal(Object.keys(D).length, 87);
});
