/**
 * The small window «In der App öffnen» shows while the app downloads a share's Freigabe-Datei
 * (src/share/sharing.ts downloadShare): «Lädt die Buchhaltung von Anna Muster», «84 von 196 MB»,
 * and a bar. A page of its own, made here, with the system's colours (light and dark), no script
 * of its own: the main process writes the line and the bar. It closes when the download ends.
 */
import { BrowserWindow } from 'electron';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function progressWindow(parent: BrowserWindow | undefined, title: string, of: (done: number, total: number) => string): { set(done: number, total: number): void; close(): void } {
  const win = new BrowserWindow({
    width: 440, height: 150, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, show: false, title,
    ...(parent && !parent.isDestroyed() ? { parent, modal: false } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: true },
  });
  const page = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>:root{color-scheme:light dark}body{margin:0;padding:22px 24px;font:13px/1.4 -apple-system,system-ui,sans-serif;background:Canvas;color:CanvasText}
b{display:block;font-size:14px;margin-bottom:10px}progress{width:100%;height:8px}#l{margin-top:8px;color:GrayText}</style>
<b>${esc(title)}</b><progress id="p" max="1" value="0"></progress><div id="l">&nbsp;</div>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  win.once('ready-to-show', () => win.show());
  let last = 0;
  return {
    set(done, total) {
      if (win.isDestroyed()) return;
      const now = Date.now();
      if (now - last < 100 && done < total) return;
      last = now;
      const fraction = total ? Math.min(1, done / total) : 0;
      parent?.setProgressBar(fraction);
      void win.webContents.executeJavaScript(`document.getElementById('p').value=${fraction};document.getElementById('l').textContent=${JSON.stringify(of(done, total))};`).catch(() => undefined);
    },
    close() { parent?.setProgressBar(-1); if (!win.isDestroyed()) win.close(); },
  };
}

