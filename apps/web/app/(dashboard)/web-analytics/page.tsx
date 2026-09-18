import { redirect } from "next/navigation";

/** The section's default destination. */
export default function WebAnalyticsIndex() {
  redirect("/web-analytics/overview");
}
