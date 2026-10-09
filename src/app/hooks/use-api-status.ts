import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/** Whether the API answers, and whether it refuses every write (audit mode); polled every 5 s. */
export function useApiStatus(): { online: boolean; readonly: boolean } {
  const [status, setStatus] = useState({ online: false, readonly: false });

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const next = await api.status().then((s) => ({ online: true, readonly: s.readonly }), () => ({ online: false, readonly: false }));
      if (!cancelled) setStatus((prev) => (prev.online === next.online && prev.readonly === next.readonly ? prev : next));
    }

    check();
    const id = setInterval(check, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return status;
}
