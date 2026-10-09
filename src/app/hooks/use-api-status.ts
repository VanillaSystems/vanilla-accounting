import { useEffect, useState } from 'react';
import type { AuditSnapshot } from '../../audit/sources.js';
import { api, STATIC_EXPORT } from '../lib/api.js';

type Status = { online: boolean; readonly: boolean; snapshot?: AuditSnapshot };

/**
 * Whether the API answers, and whether it refuses every write (audit mode); polled every 5 s.
 * The static export's status is a file that never changes, so it is read once.
 */
export function useApiStatus(): Status {
  const [status, setStatus] = useState<Status>({ online: false, readonly: false });

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const next: Status = await api.status().then((s) => ({ online: true, readonly: s.readonly, snapshot: s.snapshot }), () => ({ online: false, readonly: false }));
      if (!cancelled) setStatus((prev) => (prev.online === next.online && prev.readonly === next.readonly && prev.snapshot === next.snapshot ? prev : next));
    }

    check();
    const id = STATIC_EXPORT ? undefined : setInterval(check, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return status;
}
