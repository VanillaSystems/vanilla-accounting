import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

type WorkspaceInfo = Awaited<ReturnType<typeof api.workspace>>;

let cached: Promise<WorkspaceInfo> | undefined;

/** The company and its bank accounts from the workspace manifest; null until loaded. Fetched once per page. */
export function useWorkspace(): WorkspaceInfo | null {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  useEffect(() => {
    let live = true;
    (cached ??= api.workspace()).then((w) => { if (live) setInfo(w); }, () => { cached = undefined; });
    return () => { live = false; };
  }, []);
  return info;
}
