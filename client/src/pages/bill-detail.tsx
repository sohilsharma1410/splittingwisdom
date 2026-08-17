import { useParams } from "wouter";
import { Receipt } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export default function BillDetail() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold">Bill</h1>
        <p className="mt-1 text-muted-foreground">Bill #{id}</p>
      </header>
      <EmptyState
        icon={Receipt}
        heading="Bill detail arrives in Checkpoint D"
        description="Bill info and the per-person share breakdown will show up here once bills are built."
      />
    </div>
  );
}
