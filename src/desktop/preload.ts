/**
 * The page's only door to the desktop app: `window.vanilla` (src/types/desktop.ts). Everything
 * else the page does goes through the local server, as in the browser.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopBridge, MenuCommand, SmokeBridge } from '../types/desktop.js';

const bridge: DesktopBridge = {
  chooseFolder: (title) => ipcRenderer.invoke('desktop:chooseFolder', title),
  onMenu(listener) {
    const handler = (_e: IpcRendererEvent, command: MenuCommand) => listener(command);
    ipcRenderer.on('desktop:menu', handler);
    return () => { ipcRenderer.off('desktop:menu', handler); };
  },
  setLanguage: (code) => ipcRenderer.send('desktop:language', code),
  resolveClaude: () => ipcRenderer.invoke('desktop:resolveClaude'),
  setupClaude: () => ipcRenderer.invoke('desktop:setupClaude'),
};

contextBridge.exposeInMainWorld('vanilla', bridge);

if (process.argv.includes('--vanilla-smoke')) {
  const smoke: SmokeBridge = {
    menu: () => ipcRenderer.invoke('smoke:menu'),
    click: (id) => ipcRenderer.invoke('smoke:click', id),
    quit: () => ipcRenderer.send('smoke:quit'),
  };
  contextBridge.exposeInMainWorld('vanillaSmoke', smoke);
}
