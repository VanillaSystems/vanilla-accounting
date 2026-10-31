/** Why a VAT adjustment (src/accounting/vat-adjustments.ts) is refused; `value`: the value refused. An API refusal carries it too (src/types/api-error.ts). */
export type AdjustmentWhy = 'period' | 'ziffer' | 'amount' | 'reason' | 'noEntry' | 'entryMissing' | 'entryNotFiled' | 'id' | 'idTaken' | 'gone';
export interface AdjustmentRefusal { code: 'vatAdjustment'; params: { why: AdjustmentWhy; value?: string } }
