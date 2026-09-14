"use client";

import Link from "next/link";
import { Compass, ExternalLink, Megaphone, MousePointer2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RelativeTime } from "@/components/relative-time";
import type { Attribution, GroupAttribution, TouchRecord } from "@/lib/api";
import { cn } from "@/lib/utils";

const kindMeta = {
  campaign: { icon: Megaphone, label: "Campaign", className: "bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  referral: { icon: ExternalLink, label: "Referral", className: "bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  direct: { icon: MousePointer2, label: "Direct", className: "bg-muted text-muted-foreground" },
} as const;

/** One-line description of where a touch came from. */
export function touchSource(t: TouchRecord): string {
  if (t.kind === "campaign") return [t.utm_source, t.utm_medium, t.utm_campaign].filter(Boolean).join(" · ") || "campaign";
  if (t.kind === "referral") return t.referrer_host || "referral";
  return "direct";
}

export function TouchBadge({ touch, className }: { touch: TouchRecord; className?: string }) {
  const meta = kindMeta[touch.kind] ?? kindMeta.direct;
  const Icon = meta.icon;
  return (
    <Badge variant="secondary" className={cn("gap-1 font-normal", meta.className, className)}>
      <Icon className="size-3" />
      <span className="truncate">{touchSource(touch)}</span>
    </Badge>
  );
}

function TouchRow({ touch, tag, showPerson }: { touch: TouchRecord; tag?: string; showPerson?: boolean }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="mt-1.5 size-2 shrink-0 rounded-full bg-border" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <TouchBadge touch={touch} />
          {tag && (
            <Badge variant="outline" className="text-[10px]">
              {tag}
            </Badge>
          )}
          {showPerson && (
            <Link href={`/users/${encodeURIComponent(touch.person_id)}`} className="font-mono text-xs text-muted-foreground hover:underline">
              {touch.person_id}
            </Link>
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {touch.landing_path || "/"}
          {touch.utm_content ? ` · ${touch.utm_content}` : ""}
          {touch.utm_term ? ` · ${touch.utm_term}` : ""}
        </div>
      </div>
      <RelativeTime value={touch.timestamp} className="shrink-0 text-xs text-muted-foreground" />
    </div>
  );
}

export function AttributionCard({
  attribution,
  title = "Attribution",
  description,
  showPerson = false,
}: {
  attribution: Attribution | GroupAttribution | undefined;
  title?: string;
  description?: string;
  showPerson?: boolean;
}) {
  const a = attribution;
  const byMember = a && "by_member" in a ? a.by_member : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description ?? "Every arrival is kept. First and last touch are derived, not stored."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!a || a.touch_count === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Compass className="size-4" /> No arrivals recorded yet.
          </div>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3">
              <div className="min-w-0">
                <dt className="mb-1 text-xs text-muted-foreground">First touch</dt>
                <dd className="flex min-w-0">{a.first_touch && <TouchBadge touch={a.first_touch} className="max-w-full" />}</dd>
              </div>
              <div className="min-w-0">
                <dt className="mb-1 text-xs text-muted-foreground">Last touch</dt>
                <dd className="flex min-w-0">{a.last_touch && <TouchBadge touch={a.last_touch} className="max-w-full" />}</dd>
              </div>
            </dl>
            {byMember && byMember.length > 1 && (
              <div>
                <div className="mb-1 text-xs text-muted-foreground">How each member arrived</div>
                <div className="space-y-1">
                  {byMember.map((m) => (
                    <div key={m.person_id} className="flex items-center justify-between gap-2 text-xs">
                      <Link href={`/users/${encodeURIComponent(m.person_id)}`} className="truncate font-mono hover:underline">
                        {m.person_id}
                      </Link>
                      <TouchBadge touch={m.first_touch} className="max-w-[60%]" />
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="mb-1 text-xs text-muted-foreground">
                {a.touch_count} {a.touch_count === 1 ? "arrival" : "arrivals"}
              </div>
              <div className="divide-y">
                {a.touches.map((t) => (
                  <TouchRow
                    key={t.message_id}
                    touch={t}
                    showPerson={showPerson}
                    tag={t.message_id === a.first_touch?.message_id ? "first" : t.message_id === a.last_touch?.message_id ? "last" : undefined}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
