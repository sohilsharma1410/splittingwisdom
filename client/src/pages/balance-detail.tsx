import { useParams } from "wouter";
import { Scale } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export default function BalanceDetail() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold">Balance</h1>
        <p className="mt-1 text-muted-foreground">Person #{id}</p>
      </header>
      <EmptyState
        icon={Scale}
        heading="Balance detail arrives in Checkpoint E"
        description="A full breakdown of how this balance was calculated, bill by bill, will show up here."
      />
    </div>
  );
}
