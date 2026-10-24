/**
 * The page's only door to the desktop app: `window.vanilla` (src/types/desktop.ts). Everything
 * else the page does goes through the local server, as in the browser.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopBridge, DictationEvent, MenuCommand, SmokeBridge } from '../types/desktop.js';

const bridge: DesktopBridge = {
  chooseFolder: (title) => ipcRenderer.invoke('desktop:chooseFolder', title),
  onMenu(listener) {
    const handler = (_e: IpcRendererEvent, command: MenuCommand) => listener(command);
    ipcRenderer.on('desktop:menu', handler);
    return () => { ipcRenderer.off('desktop:menu', handler); };
  },
  setLanguage: (code) => ipcRenderer.send('desktop:language', code),
  saveFile: (url, name) => ipcRenderer.invoke('desktop:saveFile', url, name),
  // Only where the main process found the speech recognizer (main.ts DICTATION).
  ...(process.argv.includes('--vanilla-dictation') ? { dictate } : {}),
};

// Unique across reloads of the page, so a late event of a dictation before a reload reaches no new one.
const session = Date.now().toString(36);
let dictations = 0;
function dictate(lang: string, listener: (event: DictationEvent) => void): () => void {
  const id = `${session}-${++dictations}`;
  const handler = (_e: IpcRendererEvent, of: string, event: DictationEvent) => {
    if (of !== id) return;
    if (event.kind === 'ended') ipcRenderer.off('dictation:event', handler);
    listener(event);
  };
  ipcRenderer.on('dictation:event', handler);
  ipcRenderer.send('dictation:start', id, lang);
  return () => ipcRenderer.send('dictation:stop', id);
}

contextBridge.exposeInMainWorld('vanilla', bridge);

if (process.argv.includes('--vanilla-smoke')) {
  const smoke: SmokeBridge = {
    menu: () => ipcRenderer.invoke('smoke:menu'),
    click: (id) => ipcRenderer.invoke('smoke:click', id),
    quit: () => ipcRenderer.send('smoke:quit'),
  };
  contextBridge.exposeInMainWorld('vanillaSmoke', smoke);
}
