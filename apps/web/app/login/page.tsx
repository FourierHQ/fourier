"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { FourierLockup } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuthStatus, useLogin, useSetup } from "@/lib/api";

/**
 * One route, two jobs. An unclaimed instance shows "create the first account";
 * after that it shows a sign-in form. Which one is decided by the server, so a
 * second person hitting the setup screen concurrently gets an honest error
 * rather than a second admin account.
 */
export default function LoginPage() {
  const router = useRouter();
  const status = useAuthStatus();

  useEffect(() => {
    if (status.data?.user || status.data?.auth_disabled) router.replace("/");
  }, [status.data, router]);

  if (status.isLoading) {
    return <Centered><p className="text-sm text-muted-foreground">Checking…</p></Centered>;
  }

  if (status.isError) {
    return (
      <Centered>
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Can&apos;t reach the server</CardTitle>
            <CardDescription>Fourier couldn&apos;t talk to its API. Check that the server is running and that ClickHouse is reachable.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" className="w-full" onClick={() => status.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </Centered>
    );
  }

  return <Centered>{status.data?.setup_required ? <SetupForm tokenRequired={Boolean(status.data.setup_token_required)} /> : <LoginForm />}</Centered>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-12">
      <FourierLockup className="text-lg" />
      {children}
    </main>
  );
}

function SetupForm({ tokenRequired }: { tokenRequired: boolean }) {
  const router = useRouter();
  const setup = useSetup();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setup.mutate(
      { email, password, name: name || undefined, token: token || undefined },
      { onSuccess: () => router.replace("/") },
    );
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>Nobody has claimed this Fourier instance yet. The first account becomes the admin.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Name" htmlFor="name">
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" autoComplete="name" />
          </Field>
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </Field>
          <Field label="Password" htmlFor="password" hint="At least 8 characters.">
            <Input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </Field>
          {tokenRequired && (
            <Field label="Setup token" htmlFor="token" hint="This server was configured to require one.">
              <Input id="token" required value={token} onChange={(e) => setToken(e.target.value)} />
            </Field>
          )}
          {setup.error && <ErrorText>{setup.error.message}</ErrorText>}
          <Button type="submit" disabled={setup.isPending}>
            {setup.isPending ? "Creating…" : "Create account"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function LoginForm() {
  const router = useRouter();
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => router.replace("/") });
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Use the account you created when this instance was set up.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          {login.error && <ErrorText>{login.error.message}</ErrorText>}
          <Button type="submit" disabled={login.isPending}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-destructive">{children}</p>;
}
