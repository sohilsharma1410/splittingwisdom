// Small decorative illustrations for the three onboarding steps. They use the
// theme tokens (mint/teal/coral/border/surface) so they follow light and dark
// mode, and are aria-hidden: the step title and text carry the meaning.
const common = { width: 72, height: 72, viewBox: "0 0 72 72", fill: "none", "aria-hidden": true } as const;

/** A receipt with line items — "add a bill". */
export function ReceiptIllustration() {
  return (
    <svg {...common}>
      <path d="M16 8h40v52l-6.7-4.5-6.6 4.5-6.7-4.5-6.7 4.5-6.6-4.5L16 60V8Z" fill="var(--surface)" stroke="var(--border)" strokeWidth="2" strokeLinejoin="round" />
      <path d="M24 20h14M24 29h24M24 38h18" stroke="var(--muted-foreground)" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="48" cy="20" r="3" fill="var(--mint)" />
      <circle cx="48" cy="38" r="3" fill="var(--teal)" />
    </svg>
  );
}

/** Items being handed to people — "assign items". */
export function AssignIllustration() {
  return (
    <svg {...common}>
      <circle cx="18" cy="20" r="8" fill="var(--mint)" opacity="0.9" />
      <circle cx="18" cy="52" r="8" fill="var(--teal)" opacity="0.9" />
      <rect x="44" y="12" width="20" height="14" rx="4" fill="var(--surface)" stroke="var(--border)" strokeWidth="2" />
      <rect x="44" y="45" width="20" height="14" rx="4" fill="var(--surface)" stroke="var(--border)" strokeWidth="2" />
      <path d="M28 21c6 0 8 1 14 1M28 51c6 0 8-1 14-1M28 24c5 8 9 18 14 24" stroke="var(--muted-foreground)" strokeWidth="2" strokeLinecap="round" strokeDasharray="1 5" />
      <circle cx="54" cy="19" r="2.5" fill="var(--mint)" />
      <circle cx="54" cy="52" r="2.5" fill="var(--teal)" />
    </svg>
  );
}

/** A balanced scale with a check — "track and settle". */
export function SettleIllustration() {
  return (
    <svg {...common}>
      <path d="M36 12v40M24 56h24" stroke="var(--muted-foreground)" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M14 22h44" stroke="var(--muted-foreground)" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M14 22 8 38a10 7 0 0 0 12 0L14 22ZM58 22l-6 16a10 7 0 0 0 12 0l-6-16Z" fill="var(--surface)" stroke="var(--border)" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="36" cy="12" r="5" fill="var(--mint)" />
      <path d="m33.5 12 1.8 1.8 3.4-3.6" stroke="var(--mint-foreground)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
