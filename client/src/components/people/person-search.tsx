import { useState, type FormEvent } from "react";
import { Search, Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InitialsAvatar } from "@/components/ui/avatar";
import { useSearchPeople, type Person } from "@/hooks/use-people";

interface PersonSearchProps {
  onAdd: (person: Person) => void;
  excludeIds: number[];
  knownPeople?: Person[];
}

export function PersonSearch({ onAdd, excludeIds, knownPeople = [] }: PersonSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Person[] | null>(null);
  const search = useSearchPeople();

  const shortlist = knownPeople.filter((p) => !excludeIds.includes(p.id));

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    const res = await search.mutateAsync(query.trim());
    setResults(res.people.filter((p) => !excludeIds.includes(p.id)));
  }

  function handleAdd(person: Person) {
    onAdd(person);
    setResults((r) => r?.filter((p) => p.id !== person.id) ?? null);
  }

  return (
    <div className="space-y-3">
      {shortlist.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">People you've split with before</p>
          <div className="flex flex-wrap gap-1.5">
            {shortlist.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => handleAdd(p)}
                className="flex items-center gap-1.5 rounded-full border border-border py-1 pl-1 pr-2.5 text-sm hover:bg-foreground/5"
              >
                <InitialsAvatar name={p.displayName} className="h-6 w-6 text-[10px]" />
                {p.displayName}
                <Plus className="h-3.5 w-3.5 text-mint" aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={handleSearch} className="flex gap-2">
        <Input
          placeholder="Search by name, email, or phone"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setResults(null);
          }}
          aria-label="Search for a person"
        />
        <Button type="submit" variant="outline" disabled={search.isPending || !query.trim()}>
          {search.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Search className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </form>

      {results &&
        (results.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No one found. If they're not on SplittingWisdom yet, send them an invite link instead.
          </p>
        ) : (
          <div className="space-y-1.5">
            {results.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2">
                <div className="flex items-center gap-2">
                  <InitialsAvatar name={p.displayName} className="h-7 w-7 text-xs" />
                  <span className="text-sm font-medium">{p.displayName}</span>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={() => handleAdd(p)}>
                  Add
                </Button>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
