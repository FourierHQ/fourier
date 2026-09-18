"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuthStatus, useChangePassword, useUpdateAccount } from "@/lib/api";

/** Your own account: what your name is here, and the password you sign in with. */
export function AccountSettings() {
  const auth = useAuthStatus();
  const me = auth.data?.user;
  const disabled = Boolean(auth.data?.auth_disabled);

  return (
    <div className="space-y-6">
      {disabled && (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          Authentication is off in development, so nobody is really signed in — the account shown here is a stand-in. Run with{" "}
          <code className="font-mono text-xs">FOURIER_REQUIRE_AUTH=true</code> to sign in as a real account.
        </p>
      )}
      <ProfileCard id={me?.id ?? ""} name={me?.name ?? ""} email={me?.email ?? ""} role={me?.role ?? ""} disabled={disabled} />
      <PasswordCard disabled={disabled} />
    </div>
  );
}

function ProfileCard({ id, name: initialName, email: initialEmail, role, disabled }: { id: string; name: string; email: string; role: string; disabled: boolean }) {
  const update = useUpdateAccount();
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [saved, setSaved] = useState(false);

  // auth-status arrives after the first render, and again after a save.
  useEffect(() => {
    setName(initialName);
    setEmail(initialEmail);
  }, [initialName, initialEmail]);

  const dirty = name !== initialName || email !== initialEmail;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    update.mutate({ id, name, email }, { onSuccess: () => setSaved(true) });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          How you appear to everyone else on this instance. You sign in with this email{role ? ` and you are a${role === "admin" ? "n" : ""} ${role}` : ""}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-4">
          <Field label="Name" htmlFor="profile-name">
            <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} autoComplete="name" />
          </Field>
          <Field label="Email" htmlFor="profile-email">
            <Input id="profile-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={disabled} autoComplete="username" />
          </Field>
          {update.error && <p className="text-sm text-destructive">{update.error.message}</p>}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={disabled || !dirty || update.isPending}>
              {update.isPending ? "Saving…" : "Save changes"}
            </Button>
            {saved && !dirty && <span className="text-xs text-muted-foreground">Saved</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordCard({ disabled }: { disabled: boolean }) {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setDone(false);
    change.mutate(
      { current_password: current, new_password: next },
      {
        onSuccess: () => {
          setDone(true);
          setCurrent("");
          setNext("");
          setConfirm("");
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Changing it signs you out everywhere else. This browser stays signed in.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-4">
          <Field label="Current password" htmlFor="current-password">
            <Input
              id="current-password"
              type="password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              disabled={disabled}
              autoComplete="current-password"
            />
          </Field>
          <Field label="New password" htmlFor="new-password" hint="At least 8 characters.">
            <Input id="new-password" type="password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} disabled={disabled} autoComplete="new-password" />
          </Field>
          <Field label="Confirm new password" htmlFor="confirm-password">
            <Input
              id="confirm-password"
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={disabled}
              autoComplete="new-password"
            />
          </Field>
          {mismatch && <p className="text-sm text-destructive">Those two passwords don&apos;t match.</p>}
          {change.error && <p className="text-sm text-destructive">{change.error.message}</p>}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={disabled || mismatch || change.isPending || !current || !next}>
              {change.isPending ? "Changing…" : "Change password"}
            </Button>
            {done && <span className="text-xs text-muted-foreground">Password changed</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
