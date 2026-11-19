/** Which books the Löhne area saw last, to read its data again when they change (src/app/areas/payroll/data.ts). Pure. */
let seenBooks: object | undefined;

/** Whether `books` are other books than the ones the area saw last: a drop, a run or another area changed them. */
export function booksChanged(books: object): boolean {
  const changed = seenBooks !== undefined && seenBooks !== books;
  seenBooks = books;
  return changed;
}
