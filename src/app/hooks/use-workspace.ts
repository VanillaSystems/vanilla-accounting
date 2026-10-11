import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

type WorkspaceInfo = Awaited<ReturnType<typeof api.workspace>>;

let cached: Promise<WorkspaceInfo> | undefined;
const listeners = new Set<() => void>();

/** After a change to the manifest: every page reads it again. */
export function reloadWorkspace(): void {
  cached = undefined;
  for (const l of listeners) l();
}

/** The company, its bank accounts, filed quarters and seals; null until loaded. Fetched once per page and after a change. */
export function useWorkspace(): WorkspaceInfo | null {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    listeners.add(bump);
    return () => { listeners.delete(bump); };
  }, []);
  useEffect(() => {
    let live = true;
    (cached ??= api.workspace()).then((w) => { if (live) setInfo(w); }, () => { cached = undefined; });
    return () => { live = false; };
  }, [version]);
  return info;
}
