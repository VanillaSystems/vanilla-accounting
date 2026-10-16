/** What the Bilanz & ER list and ledger share: the account a route names, and an account's name. */
import type { Report, RouteOf } from '../../shell/route.js';
import { getAccountMap } from '../../lib/accounts.js';
import { t } from '../../i18n/index.js';
import { NO_ACCOUNT, NO_ACCOUNT_SLUG } from './model.js';

/** The account in the route: its number, or '' for entries without a counter account. */
export const accountOfRoute = (r: Extract<RouteOf<'reports'>, { report: Report }>) => (r.account === NO_ACCOUNT_SLUG ? NO_ACCOUNT : r.account);
export const routeAccount = (a: string) => (a === NO_ACCOUNT ? NO_ACCOUNT_SLUG : a);

export const accountName = (a: string, names = getAccountMap()) => (a === NO_ACCOUNT ? t('reports.vatOnly') : names[a] ?? a);
