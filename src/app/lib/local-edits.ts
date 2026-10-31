/**
 * Records a page edits ahead of the server (an invoice draft on its sheet). A read of the records
 * answers with the server's state at the moment the server took the read, which may be from before
 * a save the page sent: while the save is on the way, and for every read that began before the
 * save settled, the answer can be older than the screen, and taking it would undo the edit
 * (r5h-22, r6h-9: the unit, then the VAT rate 0.6 s later, and the line was back at – / 8.1 %; the
 * next save then carried the old line to the server). Such a record keeps the page's copy; every
 * other one takes the answer.
 */
export function localEdits() {
  let seq = 0;
  const inFlight = new Map<string, number>();
  const settled = new Map<string, number>();
  return {
    /** Marks `id` as being saved until `p` settles. */
    async saving<T>(id: string, p: Promise<T>): Promise<T> {
      inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
      try { return await p; } finally {
        const left = inFlight.get(id)! - 1;
        if (left) inFlight.set(id, left); else inFlight.delete(id);
        settled.set(id, ++seq);
      }
    },
    /** Call as a read begins; its answer goes through the returned merge with the page's copies. */
    read() {
      const since = seq;
      return <T extends { id: string }>(answer: readonly T[], page: readonly T[]): T[] => answer.map((x) => {
        const mine = (inFlight.get(x.id) ?? 0) > 0 || (settled.get(x.id) ?? 0) > since;
        return (mine && page.find((y) => y.id === x.id)) || x;
      });
    },
  };
}
