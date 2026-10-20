// The app's reference source for the Mail app on this Mac (ADR 0014, ADR 0015): every attached PDF
// is a document; photos only when `settings.photos` is true (most photos in mail are no receipts,
// and a logo in a signature is a few kilobytes). The host does the rest: asking Mail, the account
// and senders the reach lets through, the cursor, and what was delivered before. A company's own
// source for one provider starts from this file (docs/0.4.0/mail-channels.md).
const PHOTO_BYTES = 50_000;

const isDocument = (a: any, photos: boolean) =>
  /pdf/i.test(a.contentType) || /\.pdf$/i.test(a.filename)
  || (photos && /^image\//i.test(a.contentType) && a.size >= PHOTO_BYTES);

export default {
  attachments: async function* (io: any, from: any) {
    let cursor = from.cursor;
    for (;;) {
      const page = await io.mail.messages(cursor);
      for (const m of page.messages) {
        for (const a of await io.mail.attachments(m.uid)) {
          if (isDocument(a, io.settings.photos === true)) yield io.out.document(a.file, { key: `${m.messageId}#${a.filename}`, date: m.date });
        }
      }
      cursor = page.cursor;
      yield io.out.checkpoint(cursor);
      if (page.done) return;
    }
  },
};
