import { useState, type ReactNode } from "react";
import { useRoute } from "wouter";
import { Sidebar } from "@/components/shell/sidebar";
import { MobileNav } from "@/components/shell/mobile-nav";
import { MobileHeader } from "@/components/shell/mobile-header";
import { BillFormDialog } from "@/components/bills/bill-form-dialog";
import { InstallBanner } from "@/components/pwa/install-banner";
import { SettleProvider } from "@/hooks/use-settle";

export function AppShell({ children }: { children: ReactNode }) {
  const [newBillOpen, setNewBillOpen] = useState(false);
  // The FAB/sidebar "New Bill" action is global — rendered once here, not
  // per-page — so without this it always opened group-less, even while
  // already looking at a specific group. Auto-lock to that group instead.
  const [onGroupPage, groupRouteParams] = useRoute<{ id: string }>("/group/:id");
  const currentGroupId = onGroupPage && groupRouteParams ? Number(groupRouteParams.id) : undefined;

  return (
    <SettleProvider>
      <div className="flex min-h-screen bg-background text-foreground">
        <Sidebar onNewBill={() => setNewBillOpen(true)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <InstallBanner />
          <MobileHeader />
          <main className="mx-auto w-full max-w-[1152px] flex-1 animate-[page-in_220ms_ease-out] px-4 pb-24 pt-6 md:px-8 md:pb-10">
            {children}
          </main>
        </div>
        <MobileNav onNewBill={() => setNewBillOpen(true)} />
        <BillFormDialog open={newBillOpen} onOpenChange={setNewBillOpen} lockedGroupId={currentGroupId} />
      </div>
    </SettleProvider>
  );
}
