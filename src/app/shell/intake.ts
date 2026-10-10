/**
 * Files added by the add button, N or a drop on the page: PDFs go to the workspace's inbox
 * (beleg-import/), where `npm run extract` reads them. Phase 2 builds the reading in the app.
 */
import { api, errorText } from '../lib/api.js';
import { t } from '../i18n/index.js';
import type { Area, Nav } from '../areas/index.js';

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
  if (pdfs.length) nav.refresh();
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
