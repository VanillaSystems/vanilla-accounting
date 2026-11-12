import { useEffect, useState } from 'react';
import type { AuditSnapshot } from '../../audit/sources.js';
import { api, STATIC_EXPORT } from '../lib/api.js';
import { setAiOff } from '../ai/ai-off.js';

/** `known`: the API has answered once (or failed to); before that, whether the app may write is not known. */
type Status = { online: boolean; readonly: boolean; known: boolean; snapshot?: AuditSnapshot };

/**
 * Whether the API answers, and whether it refuses every write (audit mode); polled every 5 s.
 * It also tells whether the AI is switched off on this Mac (src/app/ai/ai-off.ts).
 * The static export's status is a file that never changes, so it is read once.
 */
export function useApiStatus(): Status {
  const [status, setStatus] = useState<Status>({ online: false, readonly: false, known: false });

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const next: Status = await api.status().then((s) => { setAiOff(s.aiOff === true); return { online: true, readonly: s.readonly, known: true, snapshot: s.snapshot }; }, () => ({ online: false, readonly: false, known: true }));
      if (!cancelled) setStatus((prev) => (prev.online === next.online && prev.readonly === next.readonly && prev.known && prev.snapshot === next.snapshot ? prev : next));
    }

    check();
    const id = STATIC_EXPORT ? undefined : setInterval(check, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return status;
}
