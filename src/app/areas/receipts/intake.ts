/**
 * Files added by the add button, N or a drop on any page: PDFs go to the workspace's inbox
 * (beleg-import/) and the inbox processing starts. Belege opens on the first one, shown as being
 * read until the processing reads it into the books; it keeps its id (its checksum), so it stays
 * selected.
 */
import { api, errorText } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import type { Area, Nav } from '../index.js';
import { pollInbox } from './state.js';
import { startIntake } from '../../shell/Intake.js';

/** The id extract gives the file: the first 16 hex characters of its SHA-256. */
async function idOf(file: File): Promise<string | undefined> {
  if (!crypto.subtle) return undefined;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function intake(files: File[], nav: Nav): Promise<void> {
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const skipped = files.filter((f) => !pdfs.includes(f)).map((f) => f.name);
  try {
    for (const f of pdfs) await api.upload(f, new Date(f.lastModified || Date.now()));
  } catch (e) {
    nav.toast(errorText(e));
    return;
  }
  nav.toast([pdfs.length && t('intake.done', { n: pdfs.length }), skipped.length && t('intake.skipped', { names: skipped.join(', ') })].filter(Boolean).join(' · '));
  if (!pdfs.length) return;
  void startIntake();
  const id = await idOf(pdfs[0]).catch(() => undefined);
  await pollInbox(nav.refresh);
  nav.go({ route: { area: 'receipts', ...(id && { id }) }, query: {} });
}

/** Opens the system's file dialog for PDFs. */
function pickFiles(onFiles: (files: File[]) => void) {
  const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: '.pdf,application/pdf' });
  input.onchange = () => onFiles([...(input.files ?? [])]);
  input.click();
}

export const intakeAdd: NonNullable<Area['add']> = {
  label: () => t('receipts.add'),
  title: () => t('receipts.addTitle'),
  run: ({ nav }) => pickFiles((files) => intake(files, nav)),
};
