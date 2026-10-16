/**
 * Records a page edits ahead of the server (an invoice draft on its sheet): while a record's save
 * is on the way, or when it was edited after a read of the records began, that read's answer is
 * older than the screen, and taking it would undo the edit (r5h-22: the unit, then the VAT rate
 * 0.6 s later, and a read set off by the books' change brought the old rate back). Such a record
 * keeps the page's copy; every other one takes the answer.
 */
export function localEdits() {
  let seq = 0;
  const touched = new Map<string, number>();
  const inFlight = new Map<string, number>();
  return {
    /** The page changed the record `id` just now. */
    touch(id: string): void { touched.set(id, ++seq); },
    /** Marks `id` as being saved until `p` settles. */
    async saving<T>(id: string, p: Promise<T>): Promise<T> {
      inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
      try { return await p; } finally {
        const left = inFlight.get(id)! - 1;
        if (left) inFlight.set(id, left); else inFlight.delete(id);
      }
    },
    /** Call as a read begins; its answer goes through the returned merge with the page's copies. */
    read() {
      const since = seq;
      return <T extends { id: string }>(answer: readonly T[], page: readonly T[]): T[] => answer.map((x) => {
        const mine = (inFlight.get(x.id) ?? 0) > 0 || (touched.get(x.id) ?? 0) > since;
        return (mine && page.find((y) => y.id === x.id)) || x;
      });
    },
  };
}
