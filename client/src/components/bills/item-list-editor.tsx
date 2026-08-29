import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { formatPaise, rupeesToPaise } from "@splittingwisdom/shared";

export interface ItemRow {
  key: string;
  name: string;
  price: string; // rupee text, e.g. "12.99"
  quantity: string; // whole number text, defaults to "1"
}

function safePaise(input: string): number {
  try {
    return rupeesToPaise(input || "0");
  } catch {
    return 0;
  }
}

export function itemsSubtotal(items: ItemRow[]): number {
  return items.reduce((sum, item) => sum + safePaise(item.price), 0);
}

interface ItemListEditorProps {
  items: ItemRow[];
  onChange: (items: ItemRow[]) => void;
}

export function ItemListEditor({ items, onChange }: ItemListEditorProps) {
  function addRow() {
    onChange([...items, { key: crypto.randomUUID(), name: "", price: "", quantity: "1" }]);
  }

  function updateRow(key: string, patch: Partial<ItemRow>) {
    onChange(items.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  function removeRow(key: string) {
    onChange(items.filter((item) => item.key !== key));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={item.key} className="flex items-center gap-2 rounded-lg border border-border p-2">
          <div className="flex flex-col">
            <button
              type="button"
              onClick={() => move(index, -1)}
              disabled={index === 0}
              aria-label={`Move ${item.name || "item"} up`}
              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => move(index, 1)}
              disabled={index === items.length - 1}
              aria-label={`Move ${item.name || "item"} down`}
              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <Input
            placeholder="Item name"
            value={item.name}
            onChange={(e) => updateRow(item.key, { name: e.target.value })}
            className="min-w-0 flex-1"
            aria-label="Item name"
          />
          <Input
            type="text"
            inputMode="numeric"
            placeholder="1"
            value={item.quantity}
            onChange={(e) => updateRow(item.key, { quantity: e.target.value.replace(/[^0-9]/g, "") })}
            className="w-14 text-center"
            aria-label="Quantity"
          />
          <CurrencyInput
            placeholder="0.00"
            value={item.price}
            onChange={(e) => updateRow(item.key, { price: e.target.value })}
            className="w-28"
            aria-label="Item price"
          />
          <button
            type="button"
            onClick={() => removeRow(item.key)}
            aria-label={`Remove ${item.name || "item"}`}
            className="shrink-0 text-muted-foreground hover:text-coral"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={addRow} className="w-full">
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add item
      </Button>

      <div className="flex items-center justify-between px-1 text-sm text-muted-foreground">
        <span>Items subtotal</span>
        <span className="tabular-currency">{formatPaise(itemsSubtotal(items))}</span>
      </div>
    </div>
  );
}
