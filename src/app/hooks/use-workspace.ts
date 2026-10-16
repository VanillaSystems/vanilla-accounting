import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { setJurisdiction } from '../../engines/index.js';

type WorkspaceInfo = Awaited<ReturnType<typeof api.workspace>>;

let cached: Promise<WorkspaceInfo> | undefined;
let loaded: WorkspaceInfo | undefined;
const listeners = new Set<() => void>();

/**
 * After a change to the manifest: every page reads it again, and the engines take the firm's setup
 * anew (a saved activity code reaches the review task without a reload, r7f-33).
 */
export function reloadWorkspace(): void {
  cached = undefined;
  for (const l of listeners) l();
  void api.modules().then((m) => { setJurisdiction(m.effective, m.vat); for (const l of listeners) l(); }, () => {});
}

/**
 * The company, its bank accounts, filed quarters and seals; null until loaded. Fetched once per page and after a change;
 * not while `books` is false (the desktop app's start screen, where no books are open).
 */
export function useWorkspace(books = true): WorkspaceInfo | null {
  const [info, setInfo] = useState<WorkspaceInfo | null>(loaded ?? null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    listeners.add(bump);
    return () => { listeners.delete(bump); };
  }, []);
  useEffect(() => {
    if (!books) return;
    let live = true;
    (cached ??= api.workspace().then((w) => (loaded = w))).then((w) => { if (live) setInfo(w); }, () => { cached = undefined; });
    return () => { live = false; };
  }, [version, books]);
  return info;
}

/** The manifest once a component has loaded it, for code outside components (the dock's badge). */
export const workspaceNow = (): WorkspaceInfo | undefined => loaded;
