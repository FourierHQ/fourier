import Link from "next/link";

export default function Pricing() {
  return (
    <main>
      <h1>Pricing</h1>
      <p>Navigating here sent a page event automatically.</p>
      <Link className="btn" href="/">
        ← Back
      </Link>
    </main>
  );
}
