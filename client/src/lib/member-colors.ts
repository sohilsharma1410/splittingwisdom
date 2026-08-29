/**
 * Consistent per-member color coding (SPEC §10) — the same member always
 * gets the same color everywhere (assignment editor, bill detail, activity
 * bars), deterministic from their group-member id. Deliberately a separate
 * palette from mint/coral/teal (index.css) — those are reserved for
 * primary/debt/accent semantics, not identity.
 */
const PALETTE = [
  { bg: "bg-blue-100 dark:bg-blue-900/50", text: "text-blue-800 dark:text-blue-200", dot: "bg-blue-500" },
  { bg: "bg-purple-100 dark:bg-purple-900/50", text: "text-purple-800 dark:text-purple-200", dot: "bg-purple-500" },
  { bg: "bg-amber-100 dark:bg-amber-900/50", text: "text-amber-800 dark:text-amber-200", dot: "bg-amber-500" },
  { bg: "bg-pink-100 dark:bg-pink-900/50", text: "text-pink-800 dark:text-pink-200", dot: "bg-pink-500" },
  { bg: "bg-cyan-100 dark:bg-cyan-900/50", text: "text-cyan-800 dark:text-cyan-200", dot: "bg-cyan-500" },
  { bg: "bg-lime-100 dark:bg-lime-900/50", text: "text-lime-800 dark:text-lime-200", dot: "bg-lime-500" },
  { bg: "bg-orange-100 dark:bg-orange-900/50", text: "text-orange-800 dark:text-orange-200", dot: "bg-orange-500" },
  { bg: "bg-indigo-100 dark:bg-indigo-900/50", text: "text-indigo-800 dark:text-indigo-200", dot: "bg-indigo-500" },
] as const;

export function memberColor(memberId: number) {
  return PALETTE[memberId % PALETTE.length];
}
