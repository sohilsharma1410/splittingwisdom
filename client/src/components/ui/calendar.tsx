import { DayPicker, type DayPickerProps } from "react-day-picker";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function Calendar(props: DayPickerProps) {
  return (
    <DayPicker
      showOutsideDays
      classNames={{
        months: "flex flex-col",
        month: "space-y-3",
        month_caption: "flex items-center justify-center h-9 relative",
        caption_label: "text-sm font-semibold",
        nav: "flex items-center justify-between absolute inset-x-0 top-0 h-9 px-1",
        button_previous: cn(
          "h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        ),
        button_next: cn(
          "h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        ),
        month_grid: "w-full border-collapse mt-2",
        weekdays: "flex",
        weekday: "text-muted-foreground w-9 text-xs font-medium text-center",
        week: "flex w-full mt-1",
        day: "h-9 w-9 text-center text-sm p-0 relative",
        day_button:
          "h-9 w-9 rounded-md text-sm font-normal hover:bg-foreground/5 aria-selected:opacity-100",
        selected: "[&>button]:bg-mint [&>button]:text-mint-foreground [&>button]:hover:bg-mint",
        today: "[&>button]:font-semibold [&>button]:text-mint",
        outside: "text-muted-foreground opacity-50",
        disabled: "text-muted-foreground opacity-30",
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          ),
      }}
      {...props}
    />
  );
}
