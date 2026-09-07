import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface BreakdownDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}

/** The one "how was this calculated" modal shell — Bill Detail, Activity,
 * and Balance Detail each feed their own (differently-shaped) content into
 * this, so the surrounding chrome and depth-behind-a-tap pattern reads the
 * same everywhere instead of three different inline expansions. */
export function BreakdownDialog({ open, onOpenChange, title, description, children }: BreakdownDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="max-h-[65vh] space-y-4 overflow-y-auto text-sm">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
