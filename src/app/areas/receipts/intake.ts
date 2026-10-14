/**
 * Files added by the add button or N: they open the drop dialog (src/app/shell/DropDialog.tsx),
 * like a drop on any page, and go into the inbox with «Hinzufügen».
 */
import { t } from '../../i18n/index.js';
import type { Area } from '../index.js';
import { dropFiles } from '../../shell/DropDialog.js';
import { RECEIPT_TYPES } from '../../../types/upload.js';

/** Opens the system's file dialog for PDFs, photos, bank statement files and ZIPs. */
function pickFiles(onFiles: (files: File[]) => void) {
  const accept = [...Object.keys(RECEIPT_TYPES), ...Object.values(RECEIPT_TYPES).map((e) => `.${e}`), '.jpeg', '.xml', '.zip'].join(',');
  const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept });
  input.onchange = () => onFiles([...(input.files ?? [])]);
  input.click();
}

export const intakeAdd: NonNullable<Area['add']> = {
  label: () => t('receipts.add'),
  title: () => t('receipts.addTitle'),
  run: () => pickFiles((files) => void dropFiles(files)),
};
