import { isMap, parseDocument, type YAMLMap } from 'yaml';
import { SINCE_START } from '../../src/core/dated.js';
import { manifestText } from '../../src/workspace/schema.js';

/**
 * A demo manifest as it was before the histories (schema 6): each dated field of `invoicing:` that holds
 * one entry from the start written back as its plain value, the shape the step reads.
 */
export function plainManifest(text: string): string {
  const doc = parseDocument(text);
  const inv = doc.get('invoicing') as YAMLMap | undefined;
  if (!isMap(inv)) return text;
  const plain = (n: unknown) => {
    const v = (n as { toJSON?: () => unknown })?.toJSON?.();
    return Array.isArray(v) && v.length === 1 && v[0].validFrom === SINCE_START ? v[0].value : undefined;
  };
  const payTo = inv.get('payTo');
  if (isMap(payTo)) for (const p of payTo.items) { const v = plain(p.value); if (v !== undefined) p.value = doc.createNode(v); }
  for (const key of ['paymentTerms', 'writeOffAccount', 'feeAccount', 'dunning']) { const v = plain(inv.get(key, true)); if (v !== undefined) inv.set(key, doc.createNode(v)); }
  doc.set('schema', 6);
  return manifestText(doc);
}

