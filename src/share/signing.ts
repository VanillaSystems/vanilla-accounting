/**
 * The sharer's signature on a hand-over sent by link (third review of PR #538). Each books keeps an
 * Ed25519 key pair per recipient: the private key in the secret store, never in the books, never in
 * a link. Every package's index is signed; the index names every file with its SHA-256 and the
 * version's checksum, so the signature covers the content. The recipient's copy pins the public key
 * of its first link (trust on first use: that first link already asks with the real facts) and
 * moves forward without a question only for a package that verifies against the pinned key.
 * A link that leaks reveals the public key alone: it lets nobody sign another package.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { secrets } from '../secrets/secrets.js';
import type { PackageIndex } from '../handover/package.js';
import type { Party } from '../handover/versions.js';

/** The bytes signed: the index without its signature, as JSON (the recipient reads the same object, in the same order). */
export function signedBytes(index: PackageIndex): Buffer {
  const { signature: _s, ...rest } = index;
  return Buffer.from(JSON.stringify(rest), 'utf8');
}

const publicOf = (key: KeyObject): string => createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');

/** The key pair of these books for `to`: made once, kept in the secret store (secrets are per books). */
async function keyFor(to: Party): Promise<KeyObject> {
  const name = `share:sign:${(to.email ?? to.name).trim().toLowerCase()}` as const;
  const kept = await secrets.get(name);
  if (kept) return createPrivateKey({ key: Buffer.from(kept, 'base64'), format: 'der', type: 'pkcs8' });
  const { privateKey } = generateKeyPairSync('ed25519');
  await secrets.set(name, privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
  return privateKey;
}

/** Signs the package's index in place: `signer` (the public key, SPKI base64), then `signature` over everything else. */
export async function signIndex(index: PackageIndex, to: Party): Promise<void> {
  const key = await keyFor(to);
  delete index.signature;
  index.signer = publicOf(key);
  index.signature = sign(null, signedBytes(index), key).toString('base64');
}

/**
 * Where a signed package was sent (fourth review of #538): the service, the share's id, a hash of
 * the recipient's return token and a hash of the signed index, signed by the same key. It travels in
 * the share's own encrypted index, which is sealed only after the service named the id and the token.
 * A package re-uploaded as another share keeps its index signature but fails this one.
 */
export interface Destination { v: 1; service: string; share: string; returnToken: string; index: string; signature: string }

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const destinationBytes = (d: Omit<Destination, 'signature'>): Buffer => Buffer.from(JSON.stringify({ v: d.v, service: d.service, share: d.share, returnToken: d.returnToken, index: d.index }), 'utf8');

export async function signDestination(index: PackageIndex, to: Party, where: { service: string; share: string; returnToken: string }): Promise<Destination> {
  const key = await keyFor(to);
  const d = { v: 1 as const, service: where.service, share: where.share, returnToken: sha(where.returnToken), index: sha(signedBytes(index)) };
  return { ...d, signature: sign(null, destinationBytes(d), key).toString('base64') };
}

/** Whether `d` says, under `signer`'s key, that `index` was sent to exactly this share of this service with this return token. */
export function sentTo(d: unknown, index: PackageIndex, signer: string, where: { service: string; share: string; returnToken?: string }): boolean {
  const x = d as Partial<Destination> | undefined;
  if (!x || x.v !== 1 || typeof x.signature !== 'string' || !where.returnToken) return false;
  if (x.service !== where.service || x.share !== where.share || x.returnToken !== sha(where.returnToken) || x.index !== sha(signedBytes(index))) return false;
  try {
    const pub = createPublicKey({ key: Buffer.from(signer, 'base64'), format: 'der', type: 'spki' });
    return pub.asymmetricKeyType === 'ed25519' && verify(null, destinationBytes(x as Destination), pub, Buffer.from(x.signature, 'base64'));
  } catch { return false; }
}

/** Whether `index` carries a signature by `signer` (default: the key it names itself) over itself. */
export function signedBy(index: PackageIndex, signer = index.signer): boolean {
  if (!signer || !index.signer || index.signer !== signer || !index.signature) return false;
  try {
    const pub = createPublicKey({ key: Buffer.from(signer, 'base64'), format: 'der', type: 'spki' });
    return pub.asymmetricKeyType === 'ed25519' && verify(null, signedBytes(index), pub, Buffer.from(index.signature, 'base64'));
  } catch { return false; }
}
