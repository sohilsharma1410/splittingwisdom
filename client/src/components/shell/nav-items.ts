import { LayoutDashboard, Users, Activity, Scale } from "lucide-react";

export const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/groups", label: "Groups", icon: Users },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/balances", label: "Balances", icon: Scale },
] as const;
