"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatNumber, parseDate } from "@/lib/format";
import type { TimeseriesPoint } from "@/lib/api";

const config = {
  count: { label: "Events", color: "var(--chart-1)" },
  users: { label: "Users", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function TimeseriesChart({ data, loading, interval = "day", className = "h-[220px] w-full" }: { data: TimeseriesPoint[] | undefined; loading?: boolean; interval?: string; className?: string }) {
  if (loading && !data) return <Skeleton className={className} />;
  const rows = (data ?? []).map((p) => ({ ...p, t: parseDate(p.bucket)?.getTime() ?? 0 }));
  const fmt = (t: number) => (interval === "hour" ? new Date(t).toLocaleTimeString(undefined, { hour: "numeric" }) : formatDate(new Date(t)));
  return (
    <ChartContainer config={config} className={className}>
      <AreaChart data={rows} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="fillCount" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-count)" stopOpacity={0.5} />
            <stop offset="95%" stopColor="var(--color-count)" stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="fillUsers" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-users)" stopOpacity={0.4} />
            <stop offset="95%" stopColor="var(--color-users)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={fmt} tickLine={false} axisLine={false} minTickGap={32} fontSize={11} />
        <YAxis tickFormatter={(v) => formatNumber(v)} tickLine={false} axisLine={false} width={40} fontSize={11} allowDecimals={false} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(_, payload) => fmt((payload?.[0]?.payload as { t: number })?.t ?? 0)} indicator="line" />} />
        <Area dataKey="count" type="monotone" fill="url(#fillCount)" stroke="var(--color-count)" strokeWidth={2} />
        <Area dataKey="users" type="monotone" fill="url(#fillUsers)" stroke="var(--color-users)" strokeWidth={2} />
      </AreaChart>
    </ChartContainer>
  );
}
