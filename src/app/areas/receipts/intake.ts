/**
 * Files added by the add button, N or a drop on any page: PDFs and photos go to the workspace's
 * inbox (beleg-import/) and the inbox processing starts (it wraps a photo into a PDF). Belege opens
 * on the first PDF, shown as being read until the processing reads it into the books; it keeps its
 * id (its checksum), so it stays selected.
 */
import { api, errorText } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import type { Area, Nav } from '../index.js';
import { pollInbox } from './state.js';
import { startIntake } from '../../automation/intake.js';
import { RECEIPT_TYPES, receiptType } from '../../../types/upload.js';

/** The id extract gives the file: the first 16 hex characters of its SHA-256. */
async function idOf(file: File): Promise<string | undefined> {
  if (!crypto.subtle) return undefined;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function intake(files: File[], nav: Nav): Promise<void> {
  const taken = files.flatMap((file) => { const type = receiptType(file); return type ? [{ file, type }] : []; });
  const skipped = files.filter((f) => !receiptType(f)).map((f) => f.name);
  try {
    for (const { file, type } of taken) await api.upload(file, type, new Date(file.lastModified || Date.now()));
  } catch (e) {
    nav.toast(errorText(e));
    return;
  }
  nav.toast([taken.length && t('intake.done', { n: taken.length }), skipped.length && t('intake.skipped', { names: skipped.join(', ') })].filter(Boolean).join(' · '));
  if (!taken.length) return;
  void startIntake();
  // A photo's id is that of the PDF it becomes, known only once it is wrapped.
  const pdf = taken.find((f) => f.type === 'application/pdf')?.file;
  const id = pdf && await idOf(pdf).catch(() => undefined);
  await pollInbox(nav.refresh);
  nav.go({ route: { area: 'receipts', ...(id && { id }) }, query: {} });
}

/** Opens the system's file dialog for PDFs and photos. */
function pickFiles(onFiles: (files: File[]) => void) {
  const accept = [...Object.keys(RECEIPT_TYPES), ...Object.values(RECEIPT_TYPES).map((e) => `.${e}`), '.jpeg'].join(',');
  const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept });
  input.onchange = () => onFiles([...(input.files ?? [])]);
  input.click();
}

export const intakeAdd: NonNullable<Area['add']> = {
  label: () => t('receipts.add'),
  title: () => t('receipts.addTitle'),
  run: ({ nav }) => pickFiles((files) => intake(files, nav)),
};
