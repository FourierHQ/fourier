"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
import { WEB_PAGES, useWebState } from "@/lib/web-state";

/**
 * Four destinations, and no more. Campaigns, referrers, engagement, devices, browsers,
 * geography and page groups are all reachable from inside one of them — as a grouping
 * control, a drilldown or a filter — because a sidebar with fourteen entries is a
 * sidebar nobody finishes reading.
 */
function SectionNav() {
  const pathname = usePathname();
  const { href } = useWebState();
  return (
    <nav className="flex items-center gap-1 border-b px-4 md:px-6" aria-label="Web Analytics">
      {WEB_PAGES.map((p) => {
        const active = pathname.startsWith(p.href);
        return (
          <Link
            key={p.href}
            // Carries the site, dates, comparison, goal and compatible filters across,
            // so moving between reports keeps whatever you were looking at.
            href={href(p.href)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            aria-current={active ? "page" : undefined}
          >
            {p.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default function WebAnalyticsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader title="Web Analytics" />
      {/* useSearchParams needs a Suspense boundary for static rendering. */}
      <Suspense fallback={<div className="h-10 border-b" />}>
        <SectionNav />
      </Suspense>
      <Suspense fallback={null}>{children}</Suspense>
    </>
  );
}
