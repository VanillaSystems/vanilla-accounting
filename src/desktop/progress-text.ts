/** «84 von 196 MB»: how far a download is, in whole megabytes (one decimal below 10 MB), in the person's words (`of`: «{done} von {total}»). */
export function progressLine(done: number, total: number, of: (values: { done: string; total: string }) => string): string {
  const mb = (n: number, max: number) => {
    const v = n / 1024 / 1024;
    return max / 1024 / 1024 < 10 ? v.toFixed(1) : String(Math.round(v));
  };
  return of({ done: mb(done, total), total: `${mb(total, total)} MB` });
}
