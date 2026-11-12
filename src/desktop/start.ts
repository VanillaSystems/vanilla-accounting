/**
 * Two moments of the app's start that went wrong together once (issue #339): the offer to move
 * into the Applications folder, and the window a click on the Dock icon brings up. Electron's
 * parts are passed in (src/desktop/main.ts), so both are tested without it.
 */

export interface MoveOffer {
  /** Packed, not a smoke run, and not in the Applications folder yet. */
  offered: boolean;
  /** The question; true for «Verschieben». */
  ask(): Promise<boolean>;
  /** Electron's `app.moveToApplicationsFolder`: true when the app was moved. It then quits this process and starts the moved one. */
  move(): boolean;
  failed(reason: string): Promise<void>;
}

/**
 * `moved`: this process is on its way out and the app in the Applications folder starts in its
 * place; the caller must start nothing more here (no server, no state file, no window: its own
 * files are in the Trash by then). `stays`: the start goes on.
 */
export async function offerMove(o: MoveOffer): Promise<'moved' | 'stays'> {
  if (!o.offered || !(await o.ask())) return 'stays';
  try {
    if (o.move()) return 'moved';
  } catch (e) {
    await o.failed((e as Error).message);
  }
  return 'stays';
}

export interface AppWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * A click on the Dock icon, `open -a`, a second start: the window comes to the front, whatever
 * became of it. None (closed): `create` opens one. One that never appeared (it waits hidden for
 * its first paint, which did not come): shown as it is, since a running app without a window
 * leaves the person nothing to click.
 */
export function bringUp(win: AppWindow | undefined, create: () => void): void {
  if (!win || win.isDestroyed()) { create(); return; }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}
