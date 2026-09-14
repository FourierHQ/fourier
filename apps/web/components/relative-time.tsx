"use client";

import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime, relativeTime } from "@/lib/format";

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
          {relativeTime(value, now)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatDateTime(value)}</TooltipContent>
    </Tooltip>
  );
}
