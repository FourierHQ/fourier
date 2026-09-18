import type { ReactNode } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b bg-background/80 px-4 py-2 backdrop-blur">
      <SidebarTrigger className="-ml-1 mr-1" />
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <h1 className="shrink-0 text-sm font-semibold">{title}</h1>
        {description && <p className="hidden truncate text-xs text-muted-foreground sm:block">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
