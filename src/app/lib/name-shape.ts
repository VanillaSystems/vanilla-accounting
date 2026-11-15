/** A file-name shape as a person reads it (src/platform/sources/aside.ts nameShape): each `#` is a number, «IMG_<Nummer>.pdf». */
import { t } from '../i18n/index.js';

export const shapeText = (shape: string): string => shape.replace(/#/g, `<${t('aside.number')}>`);
