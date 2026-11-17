import { createFileRoute } from "@tanstack/react-router";
import { useId } from "react";
import {
  AppShell,
  Button,
  Card,
  EmptyState,
  ListLayout,
  ListRow,
  MetaList,
  Pill,
  Section,
  SectionHeading,
  Stack,
  Text,
  TextLink,
} from "@hackcove/ui-react";
import { type CatalogueEntry, getCatalogue, getSignedIn } from "#/server/fns.ts";

type Search = { dismissed?: 1 };

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): Search =>
    search["dismissed"] === 1 || search["dismissed"] === "1" ? { dismissed: 1 } : {},
  loader: async () => {
    const signedIn = await getSignedIn();
    return { signedIn, catalogue: signedIn ? await getCatalogue() : null };
  },
  component: Home,
});

type Org = NonNullable<Awaited<ReturnType<typeof getCatalogue>>>[number];

function Home() {
  const { signedIn, catalogue } = Route.useLoaderData();
  const orgs = catalogue ?? [];
  // `empty` shows whenever the list has no children, so it is set only when signed in: signed out,
  // the list stays blank, as it did with the old `isEmpty`.
  return (
    <AppShell>
      <ListLayout
        title="FlakeSlash"
        actions={signedIn ? <SignOut login={signedIn.login} /> : <SignIn />}
        empty={
          signedIn ? (
            <EmptyState title="No organisations yet">
              <Text>No organisation you can reach has installed FlakeSlash.</Text>
            </EmptyState>
          ) : undefined
        }
      >
        {orgs.map((org) => (
          <OrgSection key={org.login} org={org} />
        ))}
      </ListLayout>
    </AppShell>
  );
}

function SignIn() {
  return <TextLink href="/auth/github">Sign in with GitHub</TextLink>;
}

function SignOut({ login }: { login: string }) {
  return (
    <form method="post" action="/auth/sign-out">
      <Text>
        Signed in as {login}.{" "}
        <Button type="submit" variant="link">
          Sign out
        </Button>
      </Text>
    </form>
  );
}

function unrankedText(unranked: number): string {
  return unranked === 1
    ? "1 failing issue is not a flake candidate."
    : `${unranked} failing issues are not flake candidates.`;
}

function OrgSection({ org }: { org: Org }) {
  const showDismissed = Route.useSearch().dismissed === 1;
  return (
    <Section title={org.login}>
      {org.ranked.length === 0 ? (
        <EmptyState title="No flake candidates in the last 30 days." level={3} />
      ) : (
        <Card flush>
          {org.ranked.map((entry, index) => (
            <CandidateRow key={entry.id} entry={entry} divided={index > 0} />
          ))}
        </Card>
      )}
      {org.unranked > 0 && <Text tone="muted">{unrankedText(org.unranked)}</Text>}
      {showDismissed && org.dismissed.length > 0 && <Dismissed issues={org.dismissed} />}
      {org.dismissed.length > 0 && (
        <Text>
          <TextLink href={showDismissed ? "/" : "/?dismissed=1"}>
            {showDismissed ? "Hide dismissed" : `Show dismissed (${org.dismissed.length})`}
          </TextLink>
        </Text>
      )}
    </Section>
  );
}

function reposText(repos: string[]): string {
  const shown = repos.slice(0, 3).join(", ");
  return repos.length > 3 ? `${shown} +${repos.length - 3} more` : shown;
}

function CandidateRow({ entry, divided }: { entry: CatalogueEntry; divided: boolean }) {
  return (
    <ListRow
      divided={divided}
      leading={
        <Text as="span" numeric>
          {entry.rank}
        </Text>
      }
      trailing={entry.flaky ? <Pill tone="danger">Flaky</Pill> : <Pill tone="warn">Suspect</Pill>}
      secondary={
        <MetaList>
          <span>
            {entry.rate === null ? "no flake rate" : `${Math.round(entry.rate * 100)}% flaky`}
          </span>
          <span>{entry.commits === 1 ? "1 commit" : `${entry.commits} commits`} in 30 days</span>
          <span>{entry.minutesLost} min lost</span>
          <span>{reposText(entry.repos)}</span>
        </MetaList>
      }
    >
      {entry.name}
    </ListRow>
  );
}

function Dismissed({ issues }: { issues: { id: string; name: string }[] }) {
  const headingId = useId();
  return (
    <Stack as="section" gap="sm" aria-labelledby={headingId}>
      <SectionHeading as="h3" id={headingId}>
        Dismissed
      </SectionHeading>
      <Card flush>
        {issues.map((issue, index) => (
          <ListRow key={issue.id} divided={index > 0}>
            {issue.name}
          </ListRow>
        ))}
      </Card>
    </Stack>
  );
}
