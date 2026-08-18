import type { ReactNode } from "react";
import { Sidebar } from "@/components/shell/sidebar";
import { MobileNav } from "@/components/shell/mobile-nav";
import { MobileHeader } from "@/components/shell/mobile-header";

function handleNewBill() {
  // Wired up in Checkpoint D (BillFormDialog).
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar onNewBill={handleNewBill} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileHeader />
        <main className="mx-auto w-full max-w-[1152px] flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-10">
          {children}
        </main>
      </div>
      <MobileNav onNewBill={handleNewBill} />
    </div>
  );
}
