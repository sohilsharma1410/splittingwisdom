import { Scale } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export default function Balances() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold">Balances</h1>
        <p className="mt-1 text-muted-foreground">
          Who owes you, and who you owe.
        </p>
      </header>
      <EmptyState
        icon={Scale}
        heading="No balances yet"
        description="Once you're in a group with a bill, your balances with each person will show up here."
      />
    </div>
  );
}
