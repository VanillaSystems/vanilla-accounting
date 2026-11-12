/**
 * Every message between the page's bridge (preload.ts) and the main process (main.ts). Both sides
 * name a channel only through this table, and tests/desktop-channels.test.ts holds them to it:
 * whatever one side sends, the other side takes (issue #339: the page asked on a channel nobody
 * answered, and the button did nothing).
 */

/** The page asks and awaits the answer: `ipcRenderer.invoke` in the preload, `ipcMain.handle` in the main process. */
export const ASK = {
  chooseFolder: 'desktop:chooseFolder',
  chooseNewFolder: 'desktop:chooseNewFolder',
  saveFile: 'desktop:saveFile',
  smokeMenu: 'smoke:menu',
  smokeClick: 'smoke:click',
} as const;

/** The page tells, without an answer: `ipcRenderer.send` in the preload, `ipcMain.on` in the main process. */
export const TELL = {
  language: 'desktop:language',
  dictationStart: 'dictation:start',
  dictationStop: 'dictation:stop',
  smokeQuit: 'smoke:quit',
} as const;

/** The main process tells the page: `webContents.send` in the main process, `ipcRenderer.on` in the preload. */
export const PUSH = {
  menu: 'desktop:menu',
  dictationEvent: 'dictation:event',
} as const;
