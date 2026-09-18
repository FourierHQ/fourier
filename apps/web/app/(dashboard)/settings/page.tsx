"use client";

import { AccountSettings } from "@/components/account-settings";
import { EventSettings } from "@/components/event-settings";
import { PageHeader } from "@/components/page-header";
import { TeamSettings } from "@/components/team-settings";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Who you are, who else gets in, and how what arrives is read.
 *
 * Credentials still live with the data they unlock — write keys on Install, read keys
 * on API & MCP. Events are here because hiding one is not a property of any single
 * report: it changes what every number in the product means.
 */
export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Your account, who else can sign in, and which events count" />
      <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
        <Tabs defaultValue="account">
          <TabsList>
            <TabsTrigger value="account">Account</TabsTrigger>
            <TabsTrigger value="people">People</TabsTrigger>
            <TabsTrigger value="events">Events</TabsTrigger>
          </TabsList>
          <TabsContent value="account" className="pt-4">
            <AccountSettings />
          </TabsContent>
          <TabsContent value="people" className="pt-4">
            <TeamSettings />
          </TabsContent>
          <TabsContent value="events" className="pt-4">
            <EventSettings />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
