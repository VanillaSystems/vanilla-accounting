/**
 * One loop of asks (the automation store's poll of /api/automation): `ask` once, then again after
 * `delay()` while `active()`. `now()` asks at once; while an ask waits for its answer it starts no
 * second one, it notes the wish and asks once the answer is in. So there is never more than one
 * timer: before (#453), each ask at once during a pending ask left one more loop running for good.
 * Without React or Vite, so tests run it as it is.
 */
export interface Poller {
  /** Asks at once, or right after the ask that waits now; settles once an ask begun after the call has its answer. */
  now(): Promise<void>;
  /** Stops the loop: no timer is left; an ask that waits ends without a next one. */
  stop(): void;
}

export function poller(ask: () => Promise<void>, delay: () => number, active: () => boolean): Poller {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  /** The ask noted while one waits: begun once the answer is in, the callers of `now()` waiting for it. */
  let again: Promise<void> | undefined;
  let stopped = false;
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clear();
    if (!stopped && active()) timer = setTimeout(() => { timer = undefined; void run(); }, delay());
  };
  function run(): Promise<void> {
    if (pending) return (again ??= pending.then(() => { again = undefined; return run(); }));
    clear();
    stopped = false;
    pending = ask().finally(() => { pending = undefined; if (!again) schedule(); });
    return pending;
  }
  return {
    now: run,
    stop: () => { stopped = true; clear(); },
  };
}
