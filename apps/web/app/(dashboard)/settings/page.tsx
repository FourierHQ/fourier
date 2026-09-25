"use client";

import { useEffect, useState } from "react";
import { AccountSettings } from "@/components/account-settings";
import { EventSettings } from "@/components/event-settings";
import { ImportSettings } from "@/components/import-settings";
import { PageHeader } from "@/components/page-header";
import { TeamSettings } from "@/components/team-settings";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TABS = ["account", "people", "events", "import"] as const;

/**
 * Who you are, who else gets in, how what arrives is read, and what can be brought in
 * from elsewhere.
 *
 * Credentials still live with the data they unlock — write keys on Install, read keys
 * on API & MCP. Events are here because hiding one is not a property of any single
 * report: it changes what every number in the product means.
 *
 * The tab follows the URL hash, so another page can link straight to one
 * (`/settings#import`). Read in an effect rather than during render: the server has no
 * hash, and the first client paint has to agree with it.
 */
export default function SettingsPage() {
  const [tab, setTab] = useState<string>("account");
  useEffect(() => {
    const fromHash = () => {
      const hash = window.location.hash.slice(1);
      if ((TABS as readonly string[]).includes(hash)) setTab(hash);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  const choose = (value: string) => {
    setTab(value);
    window.history.replaceState(null, "", value === "account" ? window.location.pathname : `#${value}`);
  };

  return (
    <>
      <PageHeader title="Settings" description="Your account, who else can sign in, which events count, and importing" />
      <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
        <Tabs value={tab} onValueChange={choose}>
          <TabsList>
            <TabsTrigger value="account">Account</TabsTrigger>
            <TabsTrigger value="people">People</TabsTrigger>
            <TabsTrigger value="events">Events</TabsTrigger>
            <TabsTrigger value="import">Import</TabsTrigger>
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
          <TabsContent value="import" className="pt-4">
            <ImportSettings />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
