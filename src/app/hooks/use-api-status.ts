import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export function useApiStatus() {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const ok = await api.status().then(() => true, () => false);
      if (!cancelled) setOnline(ok);
    }

    check();
    const id = setInterval(check, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return online;
}
