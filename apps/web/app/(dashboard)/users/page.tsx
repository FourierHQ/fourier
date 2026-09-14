"use client";

import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { UsersTable } from "@/components/users-table";
import { useSources, useUsers } from "@/lib/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function UsersPage() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [scope, setScope] = useState<"all" | "identified">("all");
  const [source, setSource] = useState("");
  const sources = useSources();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const users = useUsers({ q: debounced || undefined, identified: scope === "identified", source: source || undefined, limit: 200 });

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone who has sent an event"
        actions={
          <>
            <Tabs value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
              <TabsList className="h-8">
                <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
                <TabsTrigger value="identified" className="text-xs">Identified</TabsTrigger>
              </TabsList>
            </Tabs>
            {(sources.data?.length ?? 0) > 1 && (
              <Select value={source || "__all__"} onValueChange={(v) => setSource(v === "__all__" ? "" : v)}>
                <SelectTrigger size="sm" className="w-40 text-xs">
                  <SelectValue placeholder="All sources" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All sources</SelectItem>
                  {sources.data!.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, id…" className="h-8 w-56 pl-7 text-xs" />
            </div>
          </>
        }
      />
      <div className="p-4 md:p-6">
        <Card className="overflow-hidden py-0">
          <UsersTable users={users.data} loading={users.isLoading} emptyDescription={debounced ? "No users match that search." : "Users appear here as soon as events arrive. Call identify() to attach names and emails."} />
        </Card>
      </div>
    </>
  );
}
