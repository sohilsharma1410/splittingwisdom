import { useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import { Users, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useInvitePreview, useJoinGroup } from "@/hooks/use-groups";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/query-client";

export default function JoinGroup() {
  const { token } = useParams<{ token: string }>();
  const [, navigate] = useLocation();
  const { user, isLoading: authLoading } = useAuth();
  const { data, isLoading, error } = useInvitePreview(token, !!user);
  const joinGroup = useJoinGroup(token);
  const { toast } = useToast();
  const [selected, setSelected] = useState<"new" | number>("new");

  if (authLoading || (isLoading && user)) {
    return (
      <div className="mx-auto max-w-lg space-y-4 px-4 py-16">
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (!user) {
    const nextPath = `/join/${token}`;
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-4 py-16 text-center">
        <Users className="h-10 w-10 text-mint" aria-hidden="true" />
        <h1 className="text-xl font-semibold">You've been invited to a group</h1>
        <p className="text-muted-foreground">Log in or create an account to join.</p>
        <div className="flex gap-2">
          <Button asChild>
            <Link href={`/login?next=${encodeURIComponent(nextPath)}`}>Log in</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/register?next=${encodeURIComponent(nextPath)}`}>Create account</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="text-muted-foreground">
          {error instanceof ApiError ? error.message : "That invite link is no longer valid."}
        </p>
      </div>
    );
  }

  if (!data) return null;

  if (data.alreadyMember) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-4 py-16 text-center">
        <Check className="h-10 w-10 text-success" aria-hidden="true" />
        <h1 className="text-xl font-semibold">You're already in {data.group.name}</h1>
        <Button asChild>
          <Link href={`/group/${data.group.id}`}>Go to group</Link>
        </Button>
      </div>
    );
  }

  async function handleJoin() {
    try {
      const result = await joinGroup.mutateAsync(
        selected === "new" ? undefined : selected,
      );
      toast({ title: `Joined ${result.group.name}`, variant: "success" });
      navigate(`/group/${result.group.id}`);
    } catch (err) {
      toast({
        title: "Couldn't join group",
        description: err instanceof ApiError ? err.message : "Something went wrong.",
        variant: "error",
      });
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6 px-4 py-16">
      <div className="text-center">
        <Users className="mx-auto h-10 w-10 text-mint" aria-hidden="true" />
        <h1 className="mt-3 text-xl font-semibold">Join "{data.group.name}"</h1>
        <p className="mt-1 text-muted-foreground">Who are you in this group?</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="sr-only">Choose your member slot</legend>
        {data.unclaimedMembers.map((member) => (
          <label
            key={member.id}
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-surface p-3 has-[:checked]:border-mint has-[:checked]:bg-mint/10"
          >
            <input
              type="radio"
              name="member-slot"
              checked={selected === member.id}
              onChange={() => setSelected(member.id)}
              className="accent-mint"
            />
            <span className="text-sm font-medium">I'm {member.displayName}</span>
          </label>
        ))}
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-surface p-3 has-[:checked]:border-mint has-[:checked]:bg-mint/10">
          <input
            type="radio"
            name="member-slot"
            checked={selected === "new"}
            onChange={() => setSelected("new")}
            className="accent-mint"
          />
          <span className="text-sm font-medium">Join as a new member ({user.displayName})</span>
        </label>
      </fieldset>

      <Button className="w-full" onClick={handleJoin} disabled={joinGroup.isPending}>
        {joinGroup.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        Join Group
      </Button>
    </div>
  );
}
