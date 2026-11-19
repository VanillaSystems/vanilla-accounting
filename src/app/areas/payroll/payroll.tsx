/**
 * Löhne (docs/specs/payroll.md §12.1): Übersicht, Lohnabrechnungen, Lohnzahlungen, Mitarbeitende, Dokumente,
 * Einstellungen, each a list and a detail beside it. The area works without the
 * AI; the sidebar reads nothing of it (§22 decision 11). It is always in the dock: a firm without wages
 * finds there what to do first (§22 decision 26).
 */
import './payroll.css';
import { t } from '../../i18n/index.js';
import { moveKey } from '../../shell/keyboard.js';
import type { Area, AreaProps, LegendItem } from '../index.js';
import { ICONS } from '../icons.js';
import type { PayrollRoute } from './common.js';
import { OverviewDetail, OverviewList } from './Overview.js';
import { listedPayslips, monthOfRoute, PayslipDetail, PayslipList } from './Payslips.js';
import { EmployeeDetailView, EmployeeList, listedEmployees } from './Employees.js';
import { listedSections, SettingsDetail, SettingsList } from './Settings.js';
import { listedPayments, PaymentDetail, PaymentList, paymentMonth, routeOfSelection, selectionOf } from './Payments.js';
import { DocumentDetail, DocumentList, documentYear, listedDocuments } from './Documents.js';
import { monthText } from './words.js';

type Props = AreaProps<PayrollRoute>;

function List(props: Props) {
  switch (props.route.view) {
    case 'overview': return <OverviewList {...props} />;
    case 'payslips': return <PayslipList {...props} />;
    case 'payments': return <PaymentList {...props} />;
    case 'employees': return <EmployeeList {...props} />;
    case 'documents': return <DocumentList {...props} />;
    case 'settings': return <SettingsList {...props} />;
  }
}

function Detail(props: Props) {
  switch (props.route.view) {
    case 'overview': return <OverviewDetail {...props} />;
    case 'payslips': return <PayslipDetail {...props} />;
    case 'payments': return <PaymentDetail {...props} />;
    case 'employees': return <EmployeeDetailView {...props} />;
    case 'documents': return <DocumentDetail {...props} />;
    case 'settings': return <SettingsDetail {...props} />;
  }
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('keys.select'), t('payroll.keySelectTip')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const payroll: Area<PayrollRoute> = {
  id: 'payroll',
  label: () => t('area.payroll'),
  dock: { key: 'l', icon: ICONS.payroll, tip: () => t('area.payroll.tip') },
  List,
  Detail,
  periodless: true,
  add: {
    label: () => t('payroll.employee.addShort'),
    title: () => t('payroll.employee.add'),
    run: (p) => p.nav.go({ route: { area: 'payroll', view: 'employees', id: 'new' }, query: {} }),
  },
  legend,
  title: (r) => {
    if (r.view === 'payslips') return r.month ? monthText(r.month) : undefined;
    if (r.view === 'payments') return r.month ? t('payroll.payments.title', { month: monthText(r.month) }) : undefined;
    if (r.view === 'documents') return r.year ? `${t('payroll.tab.documents')} ${r.year}` : undefined;
    if (r.view === 'settings' && r.section) return t('payroll.tab.settings');
    if (r.view === 'employees') return r.id === 'new' ? t('payroll.employee.add') : undefined;
    return undefined;
  },
  keys(e, p) {
    const d = moveKey(e);
    if (!d) return false;
    const r = p.route;
    if (r.view === 'payslips') {
      const ids = listedPayslips.ids;
      const i = r.employee ? ids.indexOf(r.employee) : -1;
      const next = ids[Math.min(ids.length - 1, Math.max(0, i + d))];
      if (next) p.nav.select({ ...r, month: monthOfRoute(r), employee: next });
      return true;
    }
    if (r.view === 'payments') {
      const ids = listedPayments.ids;
      const cur = selectionOf(r);
      const next = ids[Math.min(ids.length - 1, Math.max(0, (cur ? ids.indexOf(cur) : -1) + d))];
      if (next) p.nav.select(routeOfSelection(paymentMonth(r), next));
      return true;
    }
    if (r.view === 'documents') {
      const ids = listedDocuments.ids;
      const next = ids[Math.min(ids.length - 1, Math.max(0, (r.doc ? ids.indexOf(r.doc) : -1) + d))];
      if (next) p.nav.select({ ...r, year: documentYear(r), doc: next });
      return true;
    }
    if (r.view === 'employees') {
      const ids = listedEmployees.ids;
      const next = ids[Math.min(ids.length - 1, Math.max(0, (r.id ? ids.indexOf(r.id) : -1) + d))];
      if (next) p.nav.select({ ...r, id: next });
      return true;
    }
    if (r.view === 'settings') {
      const ids = listedSections.ids;
      const next = ids[Math.min(ids.length - 1, Math.max(0, (r.section ? ids.indexOf(r.section) : -1) + d))];
      if (next) p.nav.select({ ...r, section: next });
      return true;
    }
    return false;
  },
};
