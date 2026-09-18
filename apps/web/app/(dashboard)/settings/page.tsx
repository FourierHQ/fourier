"use client";

import { AccountSettings } from "@/components/account-settings";
import { PageHeader } from "@/components/page-header";
import { TeamSettings } from "@/components/team-settings";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Two things worth settling here: who you are, and who else gets in.
 *
 * Anything that configures the data itself lives with the data — write keys on
 * Install, read keys on API & MCP — so this page stays about people.
 */
export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Your account and who else can sign in" />
      <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
        <Tabs defaultValue="account">
          <TabsList>
            <TabsTrigger value="account">Account</TabsTrigger>
            <TabsTrigger value="people">People</TabsTrigger>
          </TabsList>
          <TabsContent value="account" className="pt-4">
            <AccountSettings />
          </TabsContent>
          <TabsContent value="people" className="pt-4">
            <TeamSettings />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
