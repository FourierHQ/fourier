"use client";

import { Key, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton } from "@/components/copy-button";
import { RelativeTime } from "@/components/relative-time";
import { useApiKeys, useAuthStatus, useCreateApiKey, useRevokeApiKey } from "@/lib/api";

/**
 * Read keys are the credential for everything that reads data back without a
 * browser: the MCP server, scripts, agents. Deliberately distinct from the
 * `fk_` write keys on the Install page, which only let a client send data in.
 */
export function ReadKeys() {
  const auth = useAuthStatus();
  const keys = useApiKeys();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ name: string; plaintext: string } | null>(null);

  const onCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate(trimmed, {
      onSuccess: (r) => {
        setFresh({ name: r.key.name, plaintext: r.plaintext });
        setName("");
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Key className="size-4" /> Read keys
        </CardTitle>
        <CardDescription>
          Send as <code className="font-mono text-xs">Authorization: Bearer fr_…</code> to read from the API or MCP without a browser session. Different from the write keys on
          the Install page, which only allow sending data in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {auth.data?.auth_disabled && (
          <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
            Authentication is off in development, so the API and MCP accept requests with no key. Keys become necessary once this is deployed.
          </p>
        )}

        {fresh && (
          <div className="space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
            <p className="text-sm font-medium">{fresh.name}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">{fresh.plaintext}</code>
              <CopyButton value={fresh.plaintext} />
            </div>
            <p className="text-xs text-muted-foreground">Copy it now — this is the only time it is shown. Only a hash is stored.</p>
          </div>
        )}

        <div className="flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onCreate()}
            placeholder="Key name, e.g. Claude Desktop"
            className="max-w-xs"
          />
          <Button onClick={onCreate} disabled={create.isPending || !name.trim()}>
            {create.isPending ? "Creating…" : "Create key"}
          </Button>
        </div>
        {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}

        {keys.data && keys.data.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.data.map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{k.prefix}…</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <RelativeTime value={k.created_at} />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Revoke ${k.name}`}
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(k.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
