import { createServerFn } from "@tanstack/react-start";
import { catalogueFor, orgsFor } from "./access.ts";
import { rankCatalogue, type RankedEntry } from "./rank.ts";
import { viewer } from "./session.ts";

/** What a page may know of the signed-in person: their login, never their tokens. */
export const getSignedIn = createServerFn({ method: "GET" }).handler(async () => {
  const signedIn = await viewer();
  return signedIn ? { login: signedIn.user.login } : null;
});

/** Seconds as minutes to one decimal, as the CLI's report shows them. */
const minutesOf = (seconds: number) => Math.round((seconds / 60) * 10) / 10;

function entryOf(entry: RankedEntry) {
  return {
    rank: entry.rank,
    id: entry.issue.id,
    name: entry.issue.name,
    kind: entry.issue.kind,
    flaky: entry.flakyCommits > 0,
    rate: entry.rate,
    commits: entry.commits,
    minutesLost: minutesOf(entry.secondsLost),
    repos: entry.repos,
  };
}

export type CatalogueEntry = ReturnType<typeof entryOf>;

/**
 * For each organisation the signed-in person reaches, its flake candidates in the repos they can
 * read, ranked as the CLI ranks them, and its dismissed issues. Null when nobody is signed in.
 */
export const getCatalogue = createServerFn({ method: "GET" }).handler(async () => {
  const signedIn = await viewer();
  if (!signedIn) return null;
  const now = new Date().toISOString();
  const orgs = await orgsFor(signedIn);
  return Promise.all(
    orgs.map(async (org) => {
      const ranking = await rankCatalogue(await catalogueFor(signedIn, org.id), now);
      return {
        login: org.login,
        ranked: ranking.ranked.map(entryOf),
        unranked: ranking.unranked,
        dismissed: ranking.dismissed.map((issue) => ({ id: issue.id, name: issue.name })),
      };
    }),
  );
});
