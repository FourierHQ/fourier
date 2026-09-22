"use client";

import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { compactTime, formatDateTime } from "@/lib/format";

/**
 * A timestamp as "3h" or "Sep 1", with the exact moment on hover.
 *
 * Short by default everywhere it appears. The tooltip is not a nicety here — it is the
 * other half of the decision to abbreviate, and the reason nothing is actually lost.
 */
export function RelativeTime({ value, className }: { value: string | null | undefined; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!value) return <span className={className}>—</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={value} className={className} suppressHydrationWarning>
          {compactTime(value, now)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatDateTime(value)}</TooltipContent>
    </Tooltip>
  );
}
