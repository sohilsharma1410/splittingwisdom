import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/utils";

function initialsOf(name: string) {
  return name.trim().slice(0, 2).toUpperCase();
}

export function InitialsAvatar({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal/20 text-xs font-semibold text-teal ring-2 ring-surface",
        className,
      )}
    >
      <AvatarPrimitive.Fallback delayMs={0}>{initialsOf(name)}</AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

export function AvatarStack({ names, max = 4 }: { names: string[]; max?: number }) {
  const shown = names.slice(0, max);
  const overflow = names.length - shown.length;

  return (
    <div className="flex items-center -space-x-2">
      {shown.map((name, i) => (
        <InitialsAvatar key={`${name}-${i}`} name={name} />
      ))}
      {overflow > 0 && (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-xs font-semibold ring-2 ring-surface">
          +{overflow}
        </div>
      )}
    </div>
  );
}
