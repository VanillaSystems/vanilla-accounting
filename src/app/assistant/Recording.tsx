/**
 * Beside the chat's microphone while it records: a red dot, the time since it began and what it
 * does, so recording is plain at a glance. Its own second tick re-renders only this line.
 */
import { useEffect, useState } from 'react';

/** Seconds as the clock of a recording shows them: 0:07, 1:30, 12:04. */
export const elapsed = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export function Recording({ since, label }: { since: number; label: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return (
    <small className="airec" role="status">
      <i aria-hidden="true" />
      <span className="mono" aria-hidden="true">{elapsed(Math.max(0, Math.floor((now - since) / 1000)))}</span>
      <span className="airectext">{label}</span>
    </small>
  );
}
