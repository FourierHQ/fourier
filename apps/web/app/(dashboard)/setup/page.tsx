import { PageHeader } from "@/components/page-header";
import { SetupGuide } from "@/components/setup-guide";

export const metadata = { title: "Install" };

export default function SetupPage() {
  return (
    <>
      <PageHeader title="Install" description="Get events flowing from your Next.js app" />
      <div className="mx-auto w-full max-w-4xl p-4 md:p-6">
        <SetupGuide />
      </div>
    </>
  );
}
