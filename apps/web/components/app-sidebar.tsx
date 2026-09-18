"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Activity, Bot, Building2, Globe, LayoutDashboard, LogOut, Moon, Plug, ShieldOff, Sun, Users } from "lucide-react";
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
import { useAuthStatus, useLogout } from "@/lib/api";
import { EnvironmentSwitcher } from "@/components/environment-switcher";

const nav = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  // One entry, not four. Acquisition, Pages and Conversions are tabs inside the
  // section, and campaigns, referrers, devices and page groups live inside those.
  { href: "/web-analytics", label: "Web Analytics", icon: Globe },
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
  const auth = useAuthStatus();
  const logout = useLogout();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <EnvironmentSwitcher />
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
            <SidebarMenuButton tooltip="Toggle theme" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
              <Sun className="dark:hidden" />
              <Moon className="hidden dark:block" />
              <span>Theme</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/*
            In development the API reports a synthetic account, so checking for a
            user alone would render a sign-out that clears a cookie which was
            never set and bounces straight back here. Say what is actually going
            on instead — this is also the first place anyone wonders where the
            login screen went.
          */}
          {auth.data?.auth_disabled ? (
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Authentication is off in development. Run with FOURIER_REQUIRE_AUTH=true to see the real sign-in flow." asChild>
                <div className="cursor-default">
                  <ShieldOff />
                  <span className="truncate text-xs text-muted-foreground">No sign-in (dev)</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : (
            auth.data?.user && (
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
            )
          )}
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
