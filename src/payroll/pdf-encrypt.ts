/**
 * A PDF locked with a password (docs/specs/payroll.md §6.2 step 8, §11): the standard security handler of
 * PDF 1.6 with AES-128 (V 4, R 4, AESV2), which every common reader opens. Used for a payslip sent by
 * mail: the password is set per person or generated, never the social security number. The PDF is read
 * back with pdf-lib, each string and stream encrypted with its object's key, and the encryption
 * dictionary and the file's ID written to the trailer.
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, type PDFObject } from 'pdf-lib';

/** The padding string of the standard security handler (ISO 32000-1, 7.6.3.3). */
const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const P = -4; // print and copy allowed: a payslip is the person's own document

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const md5 = (...parts: Buffer[]) => { const h = createHash('md5'); for (const p of parts) h.update(p); return h.digest(); };
const padded = (password: string) => Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32);
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };

/** Algorithm 3: the owner entry. */
function ownerEntry(owner: string, user: string): Buffer {
  let h = md5(padded(owner));
  for (let i = 0; i < 50; i++) h = md5(h);
  const key = h.subarray(0, 16);
  let o = rc4(key, padded(user));
  for (let i = 1; i <= 19; i++) o = rc4(Buffer.from(key.map((b) => b ^ i)), o);
  return o;
}

/** Algorithm 2: the file key. */
function fileKey(user: string, o: Buffer, id: Buffer): Buffer {
  let h = md5(padded(user), o, le32(P), id);
  for (let i = 0; i < 50; i++) h = md5(h.subarray(0, 16));
  return h.subarray(0, 16);
}

/** Algorithm 5: the user entry (R 3 and later). */
function userEntry(key: Buffer, id: Buffer): Buffer {
  let u = rc4(key, md5(PAD, id));
  for (let i = 1; i <= 19; i++) u = rc4(Buffer.from(key.map((b) => b ^ i)), u);
  return Buffer.concat([u, Buffer.alloc(16)]);
}

/** Algorithm 1 with AES: an object's key, and its data encrypted with a fresh IV in front. */
function encryptFor(key: Buffer, ref: PDFRef, data: Uint8Array, iv: () => Buffer): Buffer {
  const n = Buffer.from([ref.objectNumber & 255, (ref.objectNumber >> 8) & 255, (ref.objectNumber >> 16) & 255, ref.generationNumber & 255, (ref.generationNumber >> 8) & 255]);
  const objKey = md5(key, n, Buffer.from('sAlT', 'latin1')).subarray(0, 16);
  const vector = iv();
  const cipher = createCipheriv('aes-128-cbc', objKey, vector);
  return Buffer.concat([vector, cipher.update(data), cipher.final()]);
}

/**
 * `pdf` locked with `password` (the user password; the owner password a random one nobody needs). `seed`:
 * tests pass one so the same input gives the same bytes; otherwise IVs and the ID are random.
 */
export async function encryptPdf(pdf: Uint8Array, password: string, seed?: Buffer): Promise<Buffer> {
  if (!password) throw new Error('a payslip by mail needs a password');
  let counter = 0;
  const rand = (n: number) => (seed ? createHash('sha256').update(seed).update(String(counter++)).digest().subarray(0, n) : randomBytes(n));
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const ctx = doc.context;
  const id = rand(16);
  const owner = rand(16).toString('hex');
  const o = ownerEntry(owner, password);
  const key = fileKey(password, o, id);
  const u = userEntry(key, id);

  const strings = (obj: PDFObject, ref: PDFRef): PDFObject => {
    if (obj instanceof PDFString || obj instanceof PDFHexString) return PDFHexString.of(encryptFor(key, ref, obj.asBytes(), () => rand(16)).toString('hex'));
    if (obj instanceof PDFArray) { for (let i = 0; i < obj.size(); i++) obj.set(i, strings(obj.get(i), ref)); return obj; }
    if (obj instanceof PDFDict) { for (const [k, v] of obj.entries()) obj.set(k, strings(v, ref)); return obj; }
    return obj;
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      strings(obj.dict, ref);
      const enc = encryptFor(key, ref, obj.contents, () => rand(16));
      const stream = PDFRawStream.of(obj.dict, enc);
      stream.dict.set(PDFName.of('Length'), PDFNumber.of(enc.length));
      ctx.assign(ref, stream);
    } else {
      ctx.assign(ref, strings(obj, ref));
    }
  }
  const encrypt = ctx.obj({
    Filter: 'Standard', V: 4, R: 4, Length: 128, P,
    CF: { StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV2', Length: 16 } }, StmF: 'StdCF', StrF: 'StdCF',
    O: PDFHexString.of(o.toString('hex')), U: PDFHexString.of(u.toString('hex')),
  });
  ctx.trailerInfo.Encrypt = ctx.register(encrypt);
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(id.toString('hex')), PDFHexString.of(id.toString('hex'))]);
  return Buffer.from(await doc.save({ useObjectStreams: false, updateFieldAppearances: false }));
}

/** A password to give a person once: twelve letters and digits without look-alikes. */
export function generatedPassword(bytes = randomBytes(12)): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
