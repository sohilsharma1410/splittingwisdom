// Plan D3.7: every scan stores its photo before a bill exists, so photos from abandoned
// scans pile up. This finds the ones no bill uses. Pure, so its safety rules are easy to test.

export const MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** Above this many photos, deleting most of them looks like a problem rather than tidying. */
const LARGE_DELETE = 20;

export interface ReceiptFile {
  path: string;
  createdAt: string;
}

export interface CleanupPlan {
  orphans: ReceiptFile[];
  /** Why nothing should be deleted, if something looks wrong. */
  refusal: string | null;
}

export function planCleanup(input: {
  files: ReceiptFile[];
  referencedPaths: Iterable<string>;
  billCount: number;
  now: number;
  force?: boolean;
}): CleanupPlan {
  const referenced = new Set(input.referencedPaths);
  const orphans = input.files.filter((file) => {
    const created = new Date(file.createdAt).getTime();
    // An unreadable date is kept: this should never delete on a guess.
    return !referenced.has(file.path) && Number.isFinite(created) && input.now - created > MIN_AGE_MS;
  });

  let refusal: string | null = null;
  if (input.billCount === 0 && orphans.length > 0) {
    // Receipts restored before the database, for example during a cutover.
    refusal = "The database has no bills, so every photo looks abandoned. Is the database restored?";
  } else if (!input.force && orphans.length > LARGE_DELETE && orphans.length * 2 > input.files.length) {
    refusal = `This would delete ${orphans.length} of ${input.files.length} photos, which looks wrong. To allow it, use --force.`;
  }
  return { orphans, refusal };
}
