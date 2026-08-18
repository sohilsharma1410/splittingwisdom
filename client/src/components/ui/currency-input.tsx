import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const CurrencyInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type">
>(({ className, ...props }, ref) => (
  <div className="relative">
    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
      ₹
    </span>
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      className={cn(
        "tabular-currency h-10 w-full rounded-lg border border-border bg-surface py-2 pl-7 pr-3 text-right text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  </div>
));
CurrencyInput.displayName = "CurrencyInput";
