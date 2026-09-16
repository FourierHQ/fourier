"use client";

import { countryName, flagEmoji, locationLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Where an event came from, or where a person was last seen. Renders nothing at all when
 * there is no country: an install with no CDN in front of it and no local geo database
 * should look like the feature was never there, not like every row is broken.
 */
export function Location({
  country,
  city,
  text,
  prefix = "",
  className,
}: {
  country: string;
  city?: string;
  /** Print something beside the flag: the city alone, or the full "City, Country". */
  text?: "city" | "full";
  /** Leads the tooltip, e.g. "Last seen in ". */
  prefix?: string;
  className?: string;
}) {
  if (!country) return null;
  const label = locationLabel({ country, city }) || countryName(country);
  const beside = text === "full" ? label : text === "city" ? city : "";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} title={`${prefix}${label}`}>
      <span className="shrink-0 leading-none">{flagEmoji(country)}</span>
      {beside && <span className="truncate">{beside}</span>}
    </span>
  );
}
