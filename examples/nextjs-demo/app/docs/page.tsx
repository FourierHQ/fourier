import Link from "next/link";

export default function Docs() {
  return (
    <main>
      <h1>Docs</h1>
      <p>Navigating here sent a page event automatically.</p>
      <Link className="btn" href="/">
        ← Back
      </Link>
    </main>
  );
}
