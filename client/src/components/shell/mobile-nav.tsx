import { Link, useLocation } from "wouter";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NAV_ITEMS } from "@/components/shell/nav-items";
import { cn } from "@/lib/utils";

export function MobileNav({ onNewBill }: { onNewBill: () => void }) {
  const [location] = useLocation();

  return (
    <>
      <Button
        onClick={onNewBill}
        disabled
        title="Bill creation arrives in a later checkpoint"
        size="fab"
        className="fixed bottom-20 right-4 z-40 md:hidden"
        aria-label="New bill"
      >
        <Plus className="h-6 w-6" aria-hidden="true" />
      </Button>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex h-16 items-stretch border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Main navigation"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = location === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-1 text-xs font-medium",
                isActive ? "text-mint" : "text-muted-foreground",
              )}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
