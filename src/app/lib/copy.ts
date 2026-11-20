/**
 * Puts text on the clipboard: the Clipboard API, and where it refuses (no focus, no permission, an
 * older WebView), a selected text field and the copy command. True when either took it.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* the fallback below */ }
  const had = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { field.remove(); had?.focus(); }
}
