"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuthStatus } from "@/lib/api";

/**
 * Client-side gate on the dashboard shell.
 *
 * This is a redirect, not a security boundary — the dashboard is a static
 * client bundle and anyone can read it. What actually protects the data is that
 * every read route checks the session server-side; this just saves the user
 * staring at a page full of failed requests.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const status = useAuthStatus();
  const authed = Boolean(status.data?.user || status.data?.auth_disabled);

  useEffect(() => {
    if (status.isLoading) return;
    if (!authed) router.replace("/login");
  }, [status.isLoading, authed, router]);

  if (status.isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!authed) return null;
  return <>{children}</>;
}
