/** Words that depend on the firm's VAT setup: how its correction return is named, with the form number only where the jurisdiction's form is known (the effective method's). */
import { methodOf } from '../../workspace/vat-setup.js';
import { filing, vatSetup } from '../../engines/index.js';
import { t } from '../i18n/index.js';

export const correctionName = (): string => t(methodOf(vatSetup()) === 'net-rate' ? 'vat.correctionName.netRate' : 'vat.correctionName.effective');

/** The firm's filing period as a word («Quartal», «Semester»), singular and plural (r6f-29). */
export const periodWord = (): { one: string; many: string } => (filing().length === 'half'
  ? { one: t('period.word.half'), many: t('period.words.half') }
  : { one: t('period.word.quarter'), many: t('period.words.quarter') });
