import { useState } from "react";
import { Link2, Check, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";

const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

export function InviteLinkCard({ inviteToken, groupName }: { inviteToken: string; groupName: string }) {
  const [copied, setCopied] = useState(false);
  const inviteUrl = `${window.location.origin}/join/${inviteToken}`;

  async function handleCopy() {
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleShare() {
    try {
      await navigator.share({ title: groupName, url: inviteUrl });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 text-mint" aria-hidden="true" />
        <h3 className="text-sm font-semibold">Invite link</h3>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Already registered? Search for them above. Not on SplittingWisdom yet?
        Send them this link.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          readOnly
          value={inviteUrl}
          aria-label="Invite link"
          className="h-10 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
          onFocus={(e) => e.currentTarget.select()}
        />
        {canShare && (
          <Button type="button" variant="outline" onClick={handleShare} className="shrink-0">
            <Share2 className="h-4 w-4" aria-hidden="true" />
            Share
          </Button>
        )}
        <Button type="button" variant="outline" onClick={handleCopy} className="shrink-0">
          {copied ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : (
            "Copy"
          )}
        </Button>
      </div>
    </div>
  );
}
