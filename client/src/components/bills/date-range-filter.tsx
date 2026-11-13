import { useId } from "react";
import { X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { NO_RANGE, type DateRange } from "@/lib/bill-list";

const inputClass =
  "font-ui h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint";

/** "From" and "To" bill dates, both optional, with a clear button once either is set. */
export function DateRangeFilter({ value, onChange }: { value: DateRange; onChange: (next: DateRange) => void }) {
  const id = useId();
  const active = value.from !== "" || value.to !== "";
  return (
    <div role="group" aria-label="Bill dates" className="flex flex-wrap items-end gap-2">
      <div className="min-w-[8.5rem] flex-1 space-y-1">
        <Label htmlFor={`${id}-from`} className="text-xs text-muted-foreground">
          Bill date from
        </Label>
        <input
          id={`${id}-from`}
          type="date"
          value={value.from}
          max={value.to || undefined}
          onChange={(e) => onChange({ ...value, from: e.target.value })}
          className={inputClass}
        />
      </div>
      <div className="min-w-[8.5rem] flex-1 space-y-1">
        <Label htmlFor={`${id}-to`} className="text-xs text-muted-foreground">
          to
        </Label>
        <input
          id={`${id}-to`}
          type="date"
          value={value.to}
          min={value.from || undefined}
          onChange={(e) => onChange({ ...value, to: e.target.value })}
          className={inputClass}
        />
      </div>
      {active && (
        <Button type="button" variant="ghost" size="sm" className="h-10" onClick={() => onChange(NO_RANGE)}>
          <X className="h-4 w-4" aria-hidden="true" />
          Clear dates
        </Button>
      )}
    </div>
  );
}
