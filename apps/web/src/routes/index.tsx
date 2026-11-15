import { createFileRoute } from "@tanstack/react-router";
import { describeEngine } from "@hackcove/flakeslash-engine/describe";
import { AppShell, Button, PageHeading } from "@hackcove/ui-react";
import { getSignedIn } from "#/server/fns.ts";

export const Route = createFileRoute("/")({
  loader: () => getSignedIn(),
  component: Home,
});

function Home() {
  const signedIn = Route.useLoaderData();
  return (
    <AppShell>
      <PageHeading>FlakeSlash</PageHeading>
      <p>
        The dashboard is not built yet. The local scan runs from the flakeslash CLI (
        {describeEngine()}).
      </p>
      {signedIn && (
        <form method="post" action="/auth/sign-out">
          <p>
            Signed in as {signedIn.login}.{" "}
            <Button type="submit" variant="link">
              Sign out
            </Button>
          </p>
        </form>
      )}
    </AppShell>
  );
}
