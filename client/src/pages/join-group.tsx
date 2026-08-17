import { useParams } from "wouter";
import { Users } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

export default function JoinGroup() {
  const { token } = useParams<{ token: string }>();
  return (
    <div className="mx-auto max-w-lg space-y-6 px-4 py-16">
      <EmptyState
        icon={Users}
        heading="Invite links arrive in Checkpoint C"
        description={`Invite token: ${token}`}
      />
    </div>
  );
}
