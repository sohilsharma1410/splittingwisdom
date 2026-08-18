/** Parses a "YYYY-MM-DD" date-only string as a local calendar date, avoiding
 * the UTC-midnight parsing that `new Date(str)` does (which can shift the
 * displayed day depending on the viewer's timezone). */
export function parseDateOnly(dateString: string): Date {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}
