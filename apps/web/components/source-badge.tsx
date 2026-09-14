"use client";

import { Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useSources } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Names a source id. Hidden when the project only has one source, since it carries no information then. */
export function SourceBadge({ sourceId, className, always = false }: { sourceId: string; className?: string; always?: boolean }) {
  const { data } = useSources();
  if (!sourceId) return null;
  if (!always && (data?.length ?? 0) < 2) return null;
  const name = data?.find((s) => s.id === sourceId)?.name ?? sourceId;
  return (
    <Badge variant="outline" className={cn("gap-1 font-normal text-muted-foreground", className)}>
      <Globe className="size-3" />
      <span className="truncate">{name}</span>
    </Badge>
  );
}

export function useSourceName() {
  const { data } = useSources();
  return (id: string) => data?.find((s) => s.id === id)?.name ?? id;
}
