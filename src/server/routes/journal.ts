import { Router } from 'express';
import { assertOpen, withBooks, RequestError } from '../books.js';

export const router = Router();

router.patch('/api/journal-entries/:id', (req, res) => {
  const { id } = req.params;
  const updates = req.body as Partial<{ date: string; accountDebit: string; accountCredit: string; vatCode: string; description: string }>;

  return withBooks(res, (books) => {
    const entry = books.journalEntries.find((je) => je.id === id);
    if (!entry) throw new RequestError(404, 'Journal entry not found');
    assertOpen(books, [entry.date, updates.date], 'editEntry');

    if (updates.date !== undefined) entry.date = updates.date;
    if (updates.accountDebit !== undefined) entry.accountDebit = updates.accountDebit;
    if (updates.accountCredit !== undefined) entry.accountCredit = updates.accountCredit;
    if (updates.vatCode !== undefined) entry.vatCode = updates.vatCode || undefined;
    if (updates.description !== undefined) entry.description = updates.description || undefined;
    entry.origin = 'manual';
    return { ok: true };
  });
});

router.delete('/api/journal-entries/:id', (req, res) => {
  const { id } = req.params;
  return withBooks(res, (books) => {
    const entry = books.journalEntries.find((je) => je.id === id);
    if (!entry) throw new RequestError(404, 'Journal entry not found');
    assertOpen(books, [entry.date], 'deleteEntry');

    books.journalEntries = books.journalEntries.filter((je) => je.id !== id);
    return { ok: true };
  });
});
