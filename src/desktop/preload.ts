/**
 * The page's only door to the desktop app: `window.vanilla` (src/types/desktop.ts). Everything
 * else the page does goes through the local server, as in the browser.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { ASK, PUSH, TELL } from './channels.js';
import type { DesktopBridge, DictationEvent, MenuCommand, SmokeBridge } from '../types/desktop.js';

const bridge: DesktopBridge = {
  chooseFolder: (title, at) => ipcRenderer.invoke(ASK.chooseFolder, title, at),
  chooseNewFolder: (choice) => ipcRenderer.invoke(ASK.chooseNewFolder, choice),
  onMenu(listener) {
    const handler = (_e: IpcRendererEvent, command: MenuCommand) => listener(command);
    ipcRenderer.on(PUSH.menu, handler);
    return () => { ipcRenderer.off(PUSH.menu, handler); };
  },
  setLanguage: (code) => ipcRenderer.send(TELL.language, code),
  saveFile: (url, name) => ipcRenderer.invoke(ASK.saveFile, url, name),
  // Only where the main process found the speech recognizer (main.ts DICTATION).
  ...(process.argv.includes('--vanilla-dictation') ? { dictate, micAccess: () => ipcRenderer.invoke(ASK.micAccess) } : {}),
};

// Unique across reloads of the page, so a late event of a dictation before a reload reaches no new one.
const session = Date.now().toString(36);
let dictations = 0;
function dictate(lang: string, listener: (event: DictationEvent) => void): () => void {
  const id = `${session}-${++dictations}`;
  const handler = (_e: IpcRendererEvent, of: string, event: DictationEvent) => {
    if (of !== id) return;
    if (event.kind === 'ended') ipcRenderer.off(PUSH.dictationEvent, handler);
    listener(event);
  };
  ipcRenderer.on(PUSH.dictationEvent, handler);
  ipcRenderer.send(TELL.dictationStart, id, lang);
  return () => ipcRenderer.send(TELL.dictationStop, id);
}

contextBridge.exposeInMainWorld('vanilla', bridge);

if (process.argv.includes('--vanilla-smoke')) {
  const smoke: SmokeBridge = {
    menu: () => ipcRenderer.invoke(ASK.smokeMenu),
    click: (id) => ipcRenderer.invoke(ASK.smokeClick, id),
    quit: () => ipcRenderer.send(TELL.smokeQuit),
  };
  contextBridge.exposeInMainWorld('vanillaSmoke', smoke);
}
