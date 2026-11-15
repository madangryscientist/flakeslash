import { createFileRoute } from "@tanstack/react-router";
import { describeEngine } from "@hackcove/flakeslash-engine/describe";
import { AppShell, PageHeading } from "@hackcove/ui-react";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <AppShell>
      <PageHeading>FlakeSlash</PageHeading>
      <p>
        The dashboard is not built yet. The local scan runs from the flakeslash CLI (
        {describeEngine()}).
      </p>
    </AppShell>
  );
}
