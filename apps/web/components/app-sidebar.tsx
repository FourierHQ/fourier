"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Activity, Bot, Building2, Database, LayoutDashboard, LogOut, Moon, Plug, Sun, Users } from "lucide-react";
import { useTheme } from "next-themes";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { useAuthStatus, useHealth, useLogout, useOverview } from "@/lib/api";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/events", label: "Events", icon: Activity },
  { href: "/users", label: "Users", icon: Users },
  { href: "/companies", label: "Companies", icon: Building2 },
];
const setup = [
  { href: "/setup", label: "Install", icon: Plug },
  { href: "/agents", label: "API & MCP", icon: Bot },
];

export function AppSidebar() {
  const pathname = usePathname();
  const health = useHealth();
  const overview = useOverview();
  const auth = useAuthStatus();
  const logout = useLogout();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const receiving = (overview.data?.overview.total_events ?? 0) > 0;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-mono font-bold">
                  ƒ
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Fourier</span>
                  <span className="truncate text-xs text-muted-foreground">{overview.data?.project.name ?? "Analytics"}</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Explore</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {nav.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={item.label}>
                    <Link href={item.href}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Connect</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {setup.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={item.label}>
                    <Link href={item.href}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="ClickHouse" asChild>
              <div className="cursor-default">
                <Database />
                <span className="flex items-center gap-2 truncate">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      health.isLoading ? "bg-muted-foreground" : health.data?.ok ? (receiving ? "bg-emerald-500" : "bg-amber-500") : "bg-destructive",
                    )}
                  />
                  <span className="truncate text-xs text-muted-foreground">
                    {health.isLoading ? "Connecting…" : health.data?.ok ? (receiving ? "Receiving events" : "Connected, no events yet") : "ClickHouse unreachable"}
                  </span>
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Toggle theme" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
              <Sun className="dark:hidden" />
              <Moon className="hidden dark:block" />
              <span>Theme</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* Hidden in development, where there is no login to sign out of. */}
          {auth.data?.user && (
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={`Sign out (${auth.data.user.email})`}
                onClick={() => logout.mutate(undefined, { onSuccess: () => router.replace("/login") })}
                disabled={logout.isPending}
              >
                <LogOut />
                <span className="truncate">{auth.data.user.name || auth.data.user.email}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
