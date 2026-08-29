import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { InitialsAvatar } from "@/components/ui/avatar";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Input } from "@/components/ui/input";
import { memberColor } from "@/lib/member-colors";
import { cn } from "@/lib/utils";
import {
  formatPaise,
  rupeesToPaise,
  paiseToRupeeInput,
  splitEqually,
  percentageGap,
  customAmountRemaining,
  isValidRatioPart,
  computeItemShares,
} from "@splittingwisdom/shared";
import type { ItemAssignmentInput, SplitType } from "@/hooks/use-bills";

const SPLIT_LABELS: Record<SplitType, string> = {
  equal: "Equal",
  percentage: "Percentage",
  ratio: "Ratio",
  custom: "Custom",
};

interface AssignmentEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: { name: string; price: number };
  members: { id: number; displayName: string }[];
  initialAssignments: ItemAssignmentInput[];
  onSave: (assignments: ItemAssignmentInput[]) => void;
}

export function AssignmentEditor({
  open,
  onOpenChange,
  item,
  members,
  initialAssignments,
  onSave,
}: AssignmentEditorProps) {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [splitType, setSplitType] = useState<SplitType>("equal");
  const [percentText, setPercentText] = useState<Record<number, string>>({});
  const [ratioText, setRatioText] = useState<Record<number, string>>({});
  const [customText, setCustomText] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!open) return;
    if (initialAssignments.length > 0) {
      setSelectedIds(initialAssignments.map((a) => a.memberId));
      setSplitType(initialAssignments[0].splitType);
      setPercentText(
        Object.fromEntries(initialAssignments.map((a) => [a.memberId, a.percentage != null ? String(a.percentage) : ""])),
      );
      setRatioText(
        Object.fromEntries(initialAssignments.map((a) => [a.memberId, a.ratio != null ? String(a.ratio) : ""])),
      );
      setCustomText(
        Object.fromEntries(
          initialAssignments.map((a) => [a.memberId, a.customAmount != null ? paiseToRupeeInput(a.customAmount) : ""]),
        ),
      );
    } else {
      setSelectedIds(members.map((m) => m.id));
      setSplitType("equal");
      setPercentText({});
      setRatioText({});
      setCustomText({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.name]);

  // Fill blank values for newly selected members / a freshly chosen split
  // type — never clobbers a value the user already typed.
  useEffect(() => {
    if (selectedIds.length === 0) return;
    if (splitType === "percentage") {
      setPercentText((prev) => fillEqualDefaults(prev, selectedIds, 100));
    } else if (splitType === "ratio") {
      setRatioText((prev) => {
        const next = { ...prev };
        for (const id of selectedIds) if (!next[id]) next[id] = "1";
        return next;
      });
    } else if (splitType === "custom") {
      setCustomText((prev) => fillEqualCustomDefaults(prev, selectedIds, item.price));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, splitType]);

  function toggleMember(id: number) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const assignments: ItemAssignmentInput[] = selectedIds.map((memberId) => {
    if (splitType === "percentage") {
      return { memberId, splitType, percentage: Number(percentText[memberId] || 0) };
    }
    if (splitType === "ratio") {
      return { memberId, splitType, ratio: Number(ratioText[memberId] || 0) };
    }
    if (splitType === "custom") {
      return { memberId, splitType, customAmount: safeRupeesToPaise(customText[memberId]) };
    }
    return { memberId, splitType: "equal" };
  });

  const validation = validateAssignments(splitType, assignments, item.price);
  const shares =
    selectedIds.length > 0 && validation.valid
      ? computeItemShares({
          price: item.price,
          assignments: assignments.map((a) => ({
            memberId: a.memberId,
            splitType: a.splitType,
            percentage: a.percentage ?? null,
            ratio: a.ratio ?? null,
            customAmount: a.customAmount ?? null,
          })),
        })
      : selectedIds.length > 0
        ? splitEqually(item.price, selectedIds) // fallback preview while invalid, so the panel isn't empty
        : new Map<number, number>();

  function handleSave() {
    if (selectedIds.length === 0) {
      onSave([]);
      onOpenChange(false);
      return;
    }
    if (!validation.valid) return;
    onSave(assignments);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign "{item.name}"</DialogTitle>
          <DialogDescription>{formatPaise(item.price)} — who's splitting this?</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            {members.map((member) => {
              const color = memberColor(member.id);
              const checked = selectedIds.includes(member.id);
              return (
                <label
                  key={member.id}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border border-border p-2.5",
                    checked && "border-mint",
                  )}
                >
                  <Checkbox checked={checked} onCheckedChange={() => toggleMember(member.id)} />
                  <InitialsAvatar name={member.displayName} className={cn(color.bg, color.text, "h-8 w-8")} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{member.displayName}</span>
                  {checked && shares.has(member.id) && (
                    <span className="tabular-currency shrink-0 text-sm text-muted-foreground">
                      {formatPaise(shares.get(member.id) ?? 0)}
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          {selectedIds.length > 0 && (
            <div className="space-y-3">
              <div className="flex gap-2">
                {(Object.keys(SPLIT_LABELS) as SplitType[]).map((type) => (
                  <Button
                    key={type}
                    type="button"
                    size="sm"
                    variant={splitType === type ? "default" : "outline"}
                    onClick={() => setSplitType(type)}
                  >
                    {SPLIT_LABELS[type]}
                  </Button>
                ))}
              </div>

              {splitType === "percentage" && (
                <div className="space-y-2">
                  {selectedIds.map((id) => (
                    <PercentRow
                      key={id}
                      label={members.find((m) => m.id === id)?.displayName ?? ""}
                      value={percentText[id] ?? ""}
                      onChange={(v) => setPercentText((prev) => ({ ...prev, [id]: v }))}
                    />
                  ))}
                  <ValidationLine
                    valid={validation.valid}
                    text={
                      validation.valid
                        ? "Percentages total 100%"
                        : validation.gap! > 0
                          ? `${validation.gap} short of 100%`
                          : `${-validation.gap!} over 100%`
                    }
                  />
                </div>
              )}

              {splitType === "ratio" && (
                <div className="space-y-2">
                  {selectedIds.map((id) => (
                    <RatioRow
                      key={id}
                      label={members.find((m) => m.id === id)?.displayName ?? ""}
                      value={ratioText[id] ?? ""}
                      onChange={(v) => setRatioText((prev) => ({ ...prev, [id]: v }))}
                    />
                  ))}
                  {!validation.valid && <ValidationLine valid={false} text="Ratio parts must be positive whole numbers" />}
                </div>
              )}

              {splitType === "custom" && (
                <div className="space-y-2">
                  {selectedIds.map((id) => (
                    <CustomRow
                      key={id}
                      label={members.find((m) => m.id === id)?.displayName ?? ""}
                      value={customText[id] ?? ""}
                      onChange={(v) => setCustomText((prev) => ({ ...prev, [id]: v }))}
                    />
                  ))}
                  <ValidationLine
                    valid={validation.valid}
                    text={
                      validation.valid
                        ? `Amounts sum to ${formatPaise(item.price)}`
                        : validation.remaining! > 0
                          ? `${formatPaise(validation.remaining!)} left to assign`
                          : `${formatPaise(-validation.remaining!)} over the item price`
                    }
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={selectedIds.length > 0 && !validation.valid}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PercentRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-1">
        <Input
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ""))}
          className="h-9 w-20 text-right"
          aria-label={`${label}'s percentage`}
        />
        <span className="text-sm text-muted-foreground">%</span>
      </div>
    </div>
  );
}

function RatioRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <Input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ""))}
        className="h-9 w-20 text-right"
        aria-label={`${label}'s ratio part`}
      />
    </div>
  );
}

function CustomRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <CurrencyInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-28"
        aria-label={`${label}'s custom amount`}
      />
    </div>
  );
}

function ValidationLine({ valid, text }: { valid: boolean; text: string }) {
  return <p className={cn("text-xs", valid ? "text-success" : "text-coral")}>{text}</p>;
}

function safeRupeesToPaise(input: string | undefined): number {
  try {
    return rupeesToPaise(input || "0");
  } catch {
    return 0;
  }
}

function fillEqualDefaults(prev: Record<number, string>, ids: number[], total: number): Record<number, string> {
  const missing = ids.filter((id) => !prev[id]);
  if (missing.length === 0) return prev;
  const already = ids.filter((id) => prev[id]).reduce((sum, id) => sum + Number(prev[id] || 0), 0);
  const remaining = Math.max(total - already, 0);
  const base = Math.floor(remaining / missing.length);
  const remainder = remaining - base * missing.length;
  const next = { ...prev };
  missing.sort((a, b) => a - b).forEach((id, i) => {
    next[id] = String(base + (i < remainder ? 1 : 0));
  });
  return next;
}

function fillEqualCustomDefaults(prev: Record<number, string>, ids: number[], itemPrice: number): Record<number, string> {
  const missing = ids.filter((id) => !prev[id]);
  if (missing.length === 0) return prev;
  const already = ids
    .filter((id) => prev[id])
    .reduce((sum, id) => sum + safeRupeesToPaise(prev[id]), 0);
  const remaining = Math.max(itemPrice - already, 0);
  const shares = splitEqually(remaining, missing);
  const next = { ...prev };
  for (const id of missing) next[id] = paiseToRupeeInput(shares.get(id) ?? 0);
  return next;
}

function validateAssignments(
  splitType: SplitType,
  assignments: ItemAssignmentInput[],
  itemPrice: number,
): { valid: boolean; gap?: number; remaining?: number } {
  if (assignments.length === 0) return { valid: true };
  if (splitType === "equal") return { valid: true };
  if (splitType === "percentage") {
    const gap = percentageGap(assignments.map((a) => a.percentage ?? 0));
    return { valid: gap === 0, gap };
  }
  if (splitType === "ratio") {
    const valid = assignments.every((a) => isValidRatioPart(a.ratio ?? 0));
    return { valid };
  }
  const remaining = customAmountRemaining(assignments.map((a) => a.customAmount ?? 0), itemPrice);
  return { valid: remaining === 0, remaining };
}
