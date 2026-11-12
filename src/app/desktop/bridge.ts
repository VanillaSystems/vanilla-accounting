import type { DesktopBridge } from '../../types/desktop.js';

declare global {
  interface Window { vanilla?: DesktopBridge }
}

/** The calls of the bridge the page awaits. */
export type DesktopCall = 'chooseFolder' | 'chooseNewFolder' | 'saveFile';

/**
 * A call into the desktop app that failed there (issue #339: nobody answered, and the button did
 * nothing). Electron's own words («Error invoking remote method …») say nothing to a person:
 * errorText (src/app/lib/api.ts) says `text` instead; the cause goes to the console.
 */
export class DesktopCallError extends Error {
  /** The sentence for the person: a dialog that did not open, or a file that was not saved. */
  readonly text: 'desktop.saveFailed' | 'desktop.dialogFailed';
  constructor(readonly call: DesktopCall, cause: unknown) {
    super(`${call}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'DesktopCallError';
    this.text = call === 'saveFile' ? 'desktop.saveFailed' : 'desktop.dialogFailed';
  }
}

/** `bridge` with every awaited call rejecting as a DesktopCallError. */
export function plainFailures(bridge: DesktopBridge): DesktopBridge {
  const plain = <A extends unknown[], T>(call: DesktopCall, ask: (...args: A) => Promise<T>) => async (...args: A): Promise<T> => {
    try {
      return await ask(...args);
    } catch (e) {
      console.error(e);
      throw new DesktopCallError(call, e);
    }
  };
  return {
    ...bridge,
    chooseFolder: plain('chooseFolder', bridge.chooseFolder),
    chooseNewFolder: plain('chooseNewFolder', bridge.chooseNewFolder),
    saveFile: plain('saveFile', bridge.saveFile),
  };
}

/** The desktop app's bridge (src/desktop/preload.ts); undefined in a browser. */
export const desktop: DesktopBridge | undefined = typeof window === 'undefined' || !window.vanilla ? undefined : plainFailures(window.vanilla);

/** The Mac app has no title bar: the page reaches the window's top edge (src/desktop/main.ts). */
export const noTitleBar = !!desktop && /Mac/.test(navigator.userAgent);

/** The start screen shows at /start, and whenever the desktop app has no books open. */
export const START_PATH = '/start';

/** The start screen continuing the setup in `root` (src/onboarding/draft.ts): where the app opens a folder whose setup was broken off. */
export const setupPath = (root: string): string => `${START_PATH}?setup=${encodeURIComponent(root)}`;
