/** Why a rule cannot be carried out (src/booking/rules.ts parseRule); the UI words each code (`rules.refuse.<code>`). An API refusal carries it too (src/types/api-error.ts). */
export type RuleRefusal =
  | { code: 'prose' }
  | { code: 'noId' }
  | { code: 'noCondition' }
  | { code: 'field'; params: { field: string } }
  | { code: 'outcome' }
  | { code: 'question' }
  | { code: 'account'; params: { account: string } }
  /** An account the Bilanz and the Erfolgsrechnung do not show (a closing class such as 9xxx). */
  | { code: 'unplaced'; params: { account: string; classes: string } }
  | { code: 'vat'; params: { vat: string } }
  /** A code the firm's form does not take (formTakes): none on a firm not registered, no input-tax code on the net tax rate method. */
  | { code: 'codeNotTaken'; params: { vat: string; method: 'none' | 'net-rate' } }
  | { code: 'pattern'; params: { text: string } }
  | { code: 'amount' }
  | { code: 'share'; params: { share: string } }
  | { code: 'fees' }
  | { code: 'direction'; params: { direction: string } }
  | { code: 'counterparty'; params: { counterparty: string } }
  | { code: 'payer'; params: { payer: string } }
  /** `then.tags` names a reporting dimension the workspace does not declare (#127). */
  | { code: 'dimension'; params: { dimension: string } }
  /** `then.tags` is not a map of dimension to one short value. */
  | { code: 'tags' };
