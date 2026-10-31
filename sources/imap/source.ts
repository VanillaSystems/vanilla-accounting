// The app's IMAP source (ADR 0014): it decides which parts of a mail are documents, here every
// PDF attached to it. The host does the rest: the connection, the password, the senders the reach
// lets through, the addresses of the source, and what was delivered before.
export default {
  attachments: async function* (io: any, from: any) {
    let cursor = from.cursor;
    for (;;) {
      const page = await io.mail.messages(cursor);
      for (const m of page.messages) {
        for (const a of await io.mail.attachments(m.uid)) {
          if (/pdf/i.test(a.contentType) || /\.pdf$/i.test(a.filename)) yield io.out.document(a.file, { key: `${m.messageId}#${a.filename}`, date: m.date });
        }
      }
      cursor = page.cursor;
      yield io.out.checkpoint(cursor);
      if (page.done) return;
    }
  },
};
