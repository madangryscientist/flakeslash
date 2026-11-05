import { createFileRoute } from "@tanstack/react-router";
import { describeEngine } from "@hackcove/flakeslash-engine";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">FlakeSlash</h1>
      <p>The dashboard. It detects nothing yet ({describeEngine()}).</p>
    </main>
  );
}
