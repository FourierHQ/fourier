import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";

export function StatCard({ title, value, hint, loading }: { title: string; value: ReactNode; hint?: ReactNode; loading?: boolean }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-xs font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? <Skeleton className="h-7 w-20" /> : <div className="text-2xl font-semibold tabular-nums">{typeof value === "number" ? formatNumber(value) : (value ?? "—")}</div>}
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
