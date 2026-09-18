"use client";

import { KeyRound, Trash2, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAccounts, useAuthStatus, useCreateAccount, useDeleteAccount, useUpdateAccount, type Account } from "@/lib/api";
import { parseDate } from "@/lib/format";

/**
 * Who can sign in, and what they may do.
 *
 * There is no email in Fourier — no invitation links, no reset tokens, no SMTP
 * to configure. An admin sets someone's password and passes it on however they
 * already talk to each other; that person changes it from their own settings.
 */
export function TeamSettings() {
  const auth = useAuthStatus();
  const accounts = useAccounts();
  const me = auth.data?.user;
  const admin = me?.role === "admin";
  const authOff = Boolean(auth.data?.auth_disabled);

  return (
    <Card>
      <CardHeader>
        <CardTitle>People</CardTitle>
        <CardDescription>Everyone with an account can see all the data. Admins can additionally add, remove and reset other people.</CardDescription>
        {admin && (
          <CardAction>
            <AddPersonDialog />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {authOff && (
          <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
            Authentication is off in development, so these accounts aren&apos;t being asked for yet. They start mattering as soon as this is deployed, or when you run with{" "}
            <code className="font-mono text-xs">FOURIER_REQUIRE_AUTH=true</code>.
          </p>
        )}

        {accounts.error && <p className="text-sm text-destructive">{accounts.error.message}</p>}

        {accounts.data && accounts.data.length === 0 ? (
          <EmptyState
            icon={<UserPlus />}
            title="No accounts yet"
            description="Nobody has claimed this instance. The first person to open it becomes the admin."
          />
        ) : (
          accounts.data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead className="w-36">Role</TableHead>
                  <TableHead className="w-32">Last signed in</TableHead>
                  <TableHead className="w-32">Added</TableHead>
                  {admin && <TableHead className="w-20" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.data.map((account) => (
                  <PersonRow key={account.id} account={account} isMe={account.id === me?.id} canManage={Boolean(admin)} />
                ))}
              </TableBody>
            </Table>
          )
        )}
      </CardContent>
    </Card>
  );
}

function PersonRow({ account, isMe, canManage }: { account: Account; isMe: boolean; canManage: boolean }) {
  const update = useUpdateAccount();
  const remove = useDeleteAccount();
  const [error, setError] = useState<string | null>(null);

  const changeRole = (role: string) => {
    setError(null);
    update.mutate({ id: account.id, role }, { onError: (e) => setError(e.message) });
  };

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="flex items-center gap-2">
            <span className="font-medium">{account.name}</span>
            {isMe && <Badge variant="secondary">You</Badge>}
          </div>
          <div className="text-xs text-muted-foreground">{account.email}</div>
        </TableCell>
        <TableCell>
          {/* Your own role is fixed: demoting yourself is a one-way door, and
              there is nobody to undo it for you on a single-admin instance. */}
          {canManage && !isMe ? (
            <Select value={account.role} onValueChange={changeRole} disabled={update.isPending}>
              <SelectTrigger size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="member">Member</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <span className="text-sm capitalize text-muted-foreground">{account.role}</span>
          )}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {/* The epoch means the account exists but has never been signed in to. */}
          {(parseDate(account.last_login_at)?.getTime() ?? 0) > 0 ? <RelativeTime value={account.last_login_at} /> : "Never"}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          <RelativeTime value={account.created_at} />
        </TableCell>
        {canManage && (
          <TableCell>
            <div className="flex items-center gap-0.5">
              <SetPasswordDialog account={account} />
              {!isMe && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${account.name}`}
                  disabled={remove.isPending}
                  onClick={() => {
                    setError(null);
                    if (!confirm(`Remove ${account.email}? They will be signed out and won't be able to sign in again.`)) return;
                    remove.mutate(account.id, { onError: (e) => setError(e.message) });
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          </TableCell>
        )}
      </TableRow>
      {error && (
        <TableRow>
          <TableCell colSpan={canManage ? 5 : 4} className="pt-0 text-sm text-destructive">
            {error}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function AddPersonDialog() {
  const create = useCreateAccount();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("member");
  // Held until the admin closes the dialog: this is the only moment the
  // password is visible anywhere, so the dialog stays put until they have it.
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) return;
    setName("");
    setEmail("");
    setPassword("");
    setRole("member");
    setCreated(null);
    create.reset();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ email, password, name: name || undefined, role }, { onSuccess: () => setCreated({ email, password }) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus className="size-3.5" /> Add person
        </Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{created.email} can sign in</DialogTitle>
              <DialogDescription>Send them these details however you normally talk. They can change the password from their own settings.</DialogDescription>
            </DialogHeader>
            <Credentials email={created.email} password={created.password} />
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add a person</DialogTitle>
              <DialogDescription>
                You set their first password and pass it on yourself — Fourier sends no email. They can change it from their own settings.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <Field label="Name" htmlFor="new-name">
                <Input id="new-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
              </Field>
              <Field label="Email" htmlFor="new-email">
                <Input id="new-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Password" htmlFor="new-password" hint="At least 8 characters.">
                <PasswordInput id="new-password" value={password} onChange={setPassword} />
              </Field>
              <Field label="Role" htmlFor="new-role" hint="Admins can add and remove people. Members can see everything else.">
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger id="new-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
              <DialogFooter>
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending ? "Adding…" : "Add person"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SetPasswordDialog({ account }: { account: Account }) {
  const update = useUpdateAccount();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) return;
    setPassword("");
    setDone(null);
    update.reset();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    update.mutate({ id: account.id, password }, { onSuccess: () => setDone(password) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Set a new password for ${account.name}`}>
          <KeyRound className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        {done ? (
          <>
            <DialogHeader>
              <DialogTitle>Password changed</DialogTitle>
              <DialogDescription>{account.name} has been signed out everywhere. Send them the new password.</DialogDescription>
            </DialogHeader>
            <Credentials email={account.email} password={done} />
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New password for {account.name}</DialogTitle>
              <DialogDescription>
                For someone who has locked themselves out. It signs them out of every device, and you pass the new password on yourself.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <Field label="New password" htmlFor={`reset-${account.id}`} hint="At least 8 characters.">
                <PasswordInput id={`reset-${account.id}`} value={password} onChange={setPassword} />
              </Field>
              {update.error && <p className="text-sm text-destructive">{update.error.message}</p>}
              <DialogFooter>
                <Button type="submit" disabled={update.isPending}>
                  {update.isPending ? "Setting…" : "Set password"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Shown in the clear, because whoever types it has to be able to read it out. */
function PasswordInput({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="flex gap-2">
      <Input id={id} required minLength={8} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono" autoComplete="off" />
      <Button type="button" variant="outline" onClick={() => onChange(generatePassword())}>
        Generate
      </Button>
    </div>
  );
}

function Credentials({ email, password }: { email: string; password: string }) {
  return (
    <div className="space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <code className="block truncate rounded bg-muted px-2 py-1 font-mono text-xs">{email}</code>
          <code className="block truncate rounded bg-muted px-2 py-1 font-mono text-xs">{password}</code>
        </div>
        <CopyButton value={`${email}\n${password}`} />
      </div>
      <p className="text-xs text-muted-foreground">Only a hash is stored, so this is the last time the password is shown.</p>
    </div>
  );
}

/** Readable but not guessable. Meant to be copied once and then changed. */
function generatePassword(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint32Array(16));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
