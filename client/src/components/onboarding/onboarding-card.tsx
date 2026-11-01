import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AssignIllustration, ReceiptIllustration, SettleIllustration } from "@/components/onboarding/illustrations";

const DISMISSED_KEY = "splittingwisdom-onboarding-dismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Skip is remembered on this device; it's only ever offered to people with no groups yet. */
export function useOnboardingDismissed(): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(readDismissed);
  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Storage can be unavailable (private mode); it just won't persist.
    }
  };
  return [dismissed, dismiss];
}

const STEPS = [
  { Illustration: ReceiptIllustration, title: "Add a bill", text: "Enter what you spent, item by item, with any tax or tip." },
  { Illustration: AssignIllustration, title: "Assign items", text: "Say who had what — split equally, by percentage, ratio or exact amount." },
  { Illustration: SettleIllustration, title: "Track and settle", text: "See exactly how every balance was worked out, then pay it off." },
] as const;

export function OnboardingCard({
  onAddBill,
  onCreateGroup,
  onSkip,
}: {
  onAddBill: () => void;
  onCreateGroup: () => void;
  onSkip: () => void;
}) {
  return (
    <section aria-labelledby="onboarding-title" className="space-y-6 rounded-xl border border-border bg-surface p-6">
      <div>
        <h2 id="onboarding-title" className="text-xl font-semibold">
          Welcome to SplittingWisdom
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">Split fairly. Understand everything. Here's how it works.</p>
      </div>

      <ol className="grid gap-5 md:grid-cols-3">
        {STEPS.map(({ Illustration, title, text }, i) => (
          <li key={title} className="flex items-start gap-4 md:flex-col md:items-start">
            <Illustration />
            <div>
              <h3 className="text-sm font-semibold">
                <span className="text-mint-ink">{i + 1}.</span> {title}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">{text}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onAddBill}>Add your first bill</Button>
        <Button variant="outline" onClick={onCreateGroup}>
          Create a group
        </Button>
        <Button variant="ghost" onClick={onSkip} className="text-muted-foreground">
          Skip for now
        </Button>
      </div>
    </section>
  );
}
