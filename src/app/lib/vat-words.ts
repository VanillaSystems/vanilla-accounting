/** Words that depend on the firm's VAT setup: how its correction return is named, with the form number only where the ESTV's form is known (0535 on the effective method). */
import { methodOf } from '../../workspace/vat-setup.js';
import { vatSetup } from '../../engines/index.js';
import { t } from '../i18n/index.js';

export const correctionName = (): string => t(methodOf(vatSetup()) === 'net-rate' ? 'vat.correctionName.netRate' : 'vat.correctionName.effective');
