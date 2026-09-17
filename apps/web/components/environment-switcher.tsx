"use client";

import { Check, ChevronsUpDown, FlaskConical, Hammer, Rocket } from "lucide-react";
import { ENVIRONMENT_LABELS, type Environment } from "@fourierhq/core/environments";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { FourierIcon } from "@/components/logo";
import { useHealth, useOverview } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { ENVIRONMENTS, useEnvironment } from "@/lib/environment";
import { cn } from "@/lib/utils";

const ICONS: Record<Environment, typeof Rocket> = {
  production: Rocket,
  preview: FlaskConical,
  development: Hammer,
};

type Tone = "live" | "idle" | "down" | "unknown";

const DOT: Record<Tone, string> = {
  live: "bg-emerald-500",
  idle: "bg-amber-500",
  down: "bg-destructive",
  unknown: "bg-muted-foreground",
};

/**
 * Whether the environment you are looking at is actually taking events.
 *
 * "Receiving" is the last 24 hours rather than "has ever received": a project
 * that was wired up months ago and went quiet yesterday is not receiving
 * anything, and a dot that stayed green forever after the first event would say
 * nothing worth reading. ClickHouse being unreachable outranks both — there is
 * no honest answer about event flow when the database cannot be queried.
 */
function useIngestStatus(): { tone: Tone; summary: string } {
  const health = useHealth();
  const overview = useOverview();
  const o = overview.data?.overview;

  if (health.isError || health.data?.ok === false || overview.isError) return { tone: "down", summary: "ClickHouse unreachable" };
  if (!o) return { tone: "unknown", summary: "Checking…" };
  if (o.events_24h > 0) return { tone: "live", summary: "Receiving events" };
  // Quiet. How long it has been quiet is the thing you go looking for the moment
  // the dot turns amber, so say that rather than "no events in the last 24 hours".
  if (o.last_event_at) return { tone: "idle", summary: `Last event ${relativeTime(o.last_event_at)}` };
  return { tone: "idle", summary: "No events yet" };
}

/**
 * The brand block, doubling as the environment picker.
 *
 * Each environment is a separate database, so switching here is not a filter
 * being applied — it is a different set of tables, and nothing you see in one
 * has any bearing on another. That makes which one you are looking at the
 * single most important thing in the sidebar, which is why it sits under the
 * wordmark instead of in a control you have to go find.
 */
export function EnvironmentSwitcher() {
  const { environment, setEnvironment } = useEnvironment();
  const status = useIngestStatus();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg" tooltip={`${ENVIRONMENT_LABELS[environment]} — ${status.summary}`}>
          <span className="relative">
            <FourierIcon />
            {/*
              Collapsed to icons there is no room for the label, and the dot is
              the part worth keeping — it rides the tile instead, ringed so it
              reads against the mark's own onyx.
            */}
            <span
              className={cn(
                "absolute right-0.5 bottom-0.5 hidden size-2.5 rounded-full ring-2 ring-sidebar group-data-[collapsible=icon]:block",
                DOT[status.tone],
              )}
            />
          </span>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">Fourier</span>
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
                // Non-production is tinted so you cannot mistake preview numbers for real ones at a glance.
                environment !== "production" && "text-amber-600 dark:text-amber-500",
              )}
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", DOT[status.tone])} />
              <span className="truncate">{ENVIRONMENT_LABELS[environment]}</span>
            </span>
          </div>
          <ChevronsUpDown className="ml-auto opacity-50" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={4} className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuLabel className="flex items-center gap-2 py-1.5 text-xs font-normal text-muted-foreground">
          <span className={cn("size-1.5 shrink-0 rounded-full", DOT[status.tone])} />
          <span className="truncate">{status.summary}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ENVIRONMENTS.map((env) => {
          const EnvIcon = ICONS[env];
          return (
            <DropdownMenuItem key={env} onClick={() => setEnvironment(env)} className="gap-2">
              <EnvIcon className="size-3.5" />
              <span className="flex-1">{ENVIRONMENT_LABELS[env]}</span>
              {env === environment && <Check className="size-3.5" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="py-1.5 text-xs font-normal text-muted-foreground">
          Separate databases. Nothing is shared between them.
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
