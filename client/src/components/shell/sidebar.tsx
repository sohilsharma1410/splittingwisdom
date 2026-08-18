import { useState } from "react";
import { Link, useLocation } from "wouter";
import { ChevronsLeft, ChevronsRight, Plus, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { NAV_ITEMS } from "@/components/shell/nav-items";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

export function Sidebar({ onNewBill }: { onNewBill: () => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const [location, navigate] = useLocation();
  const { user, logout } = useAuth();
  const { toast } = useToast();

  const handleLogout = async () => {
    await logout();
    toast({ title: "Logged out", variant: "default" });
    navigate("/login");
  };

  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-surface transition-all duration-200 md:flex",
        collapsed ? "w-20" : "w-64",
      )}
    >
      <div className="flex items-center gap-2 px-4 py-5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-mint text-mint-foreground">
          <Scale className="h-5 w-5" aria-hidden="true" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="font-ui truncate text-base font-semibold">
              SplittingWisdom
            </p>
            <p className="truncate text-xs text-muted-foreground">
              Split fairly. Understand everything.
            </p>
          </div>
        )}
      </div>

      <div className="px-3">
        <Button
          className="w-full"
          onClick={onNewBill}
          disabled
          title="Bill creation arrives in a later checkpoint"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {!collapsed && "New Bill"}
        </Button>
      </div>

      <nav className="mt-4 flex-1 space-y-1 px-3" aria-label="Main navigation">
        {NAV_ITEMS.map((item) => {
          const isActive = location === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "font-ui flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-mint/15 text-mint"
                  : "text-foreground hover:bg-foreground/5",
              )}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              {!collapsed && item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-3">
        {user ? (
          <div className="flex min-w-0 items-center gap-2">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal/20 text-xs font-semibold text-teal"
              aria-hidden="true"
            >
              {user.displayName.slice(0, 2).toUpperCase()}
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {user.displayName}
                </p>
                <button
                  onClick={handleLogout}
                  className="text-xs text-muted-foreground hover:text-coral"
                >
                  Log out
                </button>
              </div>
            )}
          </div>
        ) : (
          !collapsed && (
            <span className="text-xs text-muted-foreground">Not signed in</span>
          )
        )}
        <ThemeToggle />
      </div>

      <button
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="flex items-center justify-center gap-2 border-t border-border py-2 text-muted-foreground hover:text-foreground"
      >
        {collapsed ? (
          <ChevronsRight className="h-4 w-4" aria-hidden="true" />
        ) : (
          <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </aside>
  );
}
