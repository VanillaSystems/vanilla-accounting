/** The service's limits (docs/api.md of the service): the dialog names them before the service refuses. Without node: the page reads them too. */
export const SHARE_LIMITS = { bytes: 1024 * 1024 * 1024, objects: 5000, sharesPerDay: 10, returnsPerShare: 5, days: 14, invitesPerShare: 10, mailsPerDay: 100 } as const;
