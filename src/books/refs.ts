/** A ref of its own (M2026-004): a manual transaction's, or an entry's that has no payment. */
export const isManualRef = (ref: string): boolean => /^M\d{4}-\d{3,}$/.test(ref);
