/** The service's limits (docs/api.md of the service): the dialog names them before the service refuses. Without node: the page reads them too. */
export const SHARE_LIMITS = { bytes: 1024 * 1024 * 1024, objects: 5000, sharesPerDay: 10, returnsPerShare: 5, days: 14, invitesPerShare: 10, mailsPerDay: 100,
  /** One return (the service's MAX_RETURN_BYTES), and the most the sharer's app fetches without her asking (refreshShares). */
  returnBytes: 200 * 1024 * 1024, returnFetchedAlone: 25 * 1024 * 1024,
  /** E-mails per sender address and day over all her shares (MAILS_PER_SENDER_PER_DAY). */
  mailsPerSenderPerDay: 20 } as const;
