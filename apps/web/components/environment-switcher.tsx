"use client";

import { Check, ChevronsUpDown, FlaskConical, Hammer, Rocket } from "lucide-react";
import { ENVIRONMENT_LABELS, type Environment } from "@fourierhq/core/environments";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { ENVIRONMENTS, useEnvironment } from "@/lib/environment";
import { cn } from "@/lib/utils";

const ICONS: Record<Environment, typeof Rocket> = {
  production: Rocket,
  preview: FlaskConical,
  development: Hammer,
};

/**
 * Switches which environment the dashboard reads. Each one is a separate database,
 * so this is not a filter being applied — it is a different set of tables, and
 * nothing you see in one has any bearing on another.
 */
export function EnvironmentSwitcher() {
  const { environment, setEnvironment } = useEnvironment();
  const Icon = ICONS[environment];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="sm"
          className={cn(
            "justify-between",
            // Non-production is tinted so you cannot mistake preview numbers for real ones at a glance.
            environment !== "production" && "text-amber-600 dark:text-amber-500",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate">{ENVIRONMENT_LABELS[environment]}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Separate databases. Nothing is shared between them.
        </DropdownMenuLabel>
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
