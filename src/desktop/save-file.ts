/**
 * A PDF the page offers to save, saved through the system's Save dialog: the page learns whether
 * the person saved it or cancelled, so an invoice is recorded as sent only once its file exists.
 * The dialog, the download and the write are passed in (src/desktop/main.ts gives Electron's).
 */
export interface SaveFileDeps {
  /** The path the person chose, undefined when they cancelled. */
  ask(name: string): Promise<string | undefined>;
  read(url: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

/** Only a file of the page's own server, never another host. */
export function sameOrigin(url: string, page: string): string | undefined {
  try {
    const u = new URL(url, page);
    return u.origin === new URL(page).origin ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export async function saveFile(url: string, name: string, deps: SaveFileDeps): Promise<boolean> {
  const path = await deps.ask(name);
  if (!path) return false;
  await deps.write(path, await deps.read(url));
  return true;
}
