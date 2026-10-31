/**
 * Saves of one thing sent one after the other, in the order they were made, so a quick second
 * change never overtakes the first at the server (corner-44: two selects of an invoice draft within
 * 0.6 s, the first answer came last and won). `latest` says no newer save of the key was waiting:
 * only its answer is shown, an older one would undo what is on the screen.
 */
export function inOrder() {
  const tail = new Map<string, Promise<unknown>>();
  const waiting = new Map<string, number>();
  return async function save<T>(key: string, call: () => Promise<T>): Promise<{ result: T; latest: boolean }> {
    waiting.set(key, (waiting.get(key) ?? 0) + 1);
    const done = (tail.get(key) ?? Promise.resolve()).then(call);
    tail.set(key, done.catch(() => undefined));
    try {
      return { result: await done, latest: waiting.get(key) === 1 };
    } finally {
      const left = waiting.get(key)! - 1;
      if (left) waiting.set(key, left); else { waiting.delete(key); tail.delete(key); }
    }
  };
}
