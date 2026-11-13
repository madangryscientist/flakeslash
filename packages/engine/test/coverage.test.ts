import { describe, expect, it } from "vitest";
import { runCoverage } from "../src/coverage.ts";
import type { JobRun } from "../src/coverage.ts";
import type { ReadAttempt } from "../src/index.ts";

const attempt = (
  runId: number,
  runAttempt: number,
  extra: Partial<ReadAttempt> = {},
): ReadAttempt => ({
  repo: "a/b",
  runId,
  runAttempt,
  conclusion: "cancelled",
  createdAt: "2026-11-04T00:00:00Z",
  latestAttempt: runAttempt,
  jobCount: 0,
  ...extra,
});

const jobOf = (runId: number, runAttempt = 1): JobRun => ({ runId, runAttempt });

/** A listing that gave each run, created in the window, at the given latest attempt. */
const listedAs = (runAttempt: number, ...ids: number[]) =>
  new Map(ids.map((id) => [id, { createdAt: "2026-11-04T00:00:00Z", runAttempt }]));

describe("runCoverage", () => {
  const since = "2026-11-01";

  it("counts a run once however many attempts, and by the latest attempt's conclusion", () => {
    const attempts = [
      attempt(1, 1, { conclusion: "failure" }),
      attempt(1, 2, { conclusion: "cancelled" }),
    ];
    expect(
      runCoverage({ attempts, jobs: [], listed: listedAs(2, 1), since, running: new Set() }),
    ).toEqual({
      read: 1,
      noJobs: 1,
      noJobsByConclusion: { cancelled: 1 },
      stillRunning: 0,
    });
  });

  it("leaves out a run created before the window", () => {
    const attempts = [attempt(1, 1, { createdAt: "2026-10-31T23:59:59Z" }), attempt(2, 1)];
    expect(
      runCoverage({ attempts, jobs: [], listed: listedAs(1, 1, 2), since, running: new Set() })
        .read,
    ).toBe(1);
  });

  it("dates a run with only jobs by the listing, and leaves out one the listing did not give", () => {
    const jobs = [jobOf(1), jobOf(2), jobOf(3)];
    const listed = new Map([
      [1, { createdAt: "2026-10-20T00:00:00Z", runAttempt: 1 }],
      [2, { createdAt: "2026-11-02T00:00:00Z", runAttempt: 1 }],
    ]);
    // Run 1 was created before the window as far as the listing goes: it is out. Run 3 was not listed.
    expect(
      runCoverage({ attempts: [], jobs, listed, since: "2026-11-01", running: new Set() }),
    ).toMatchObject({ read: 1, noJobs: 0 });
  });

  it("leaves out a run whose latest attempt was never read, as the listing gives it", () => {
    const attempts = [attempt(1, 1), attempt(2, 1), attempt(3, 2, { jobCount: 1 })];
    const listed = new Map([
      [1, { createdAt: "2026-11-02T00:00:00Z", runAttempt: 2 }],
      [2, { createdAt: "2026-11-02T00:00:00Z", runAttempt: 1 }],
      [3, { createdAt: "2026-11-02T00:00:00Z", runAttempt: 3 }],
    ]);
    // Runs 1 and 3 read attempts short of their latest: unknown. Run 2 is read in full.
    expect(
      runCoverage({ attempts, jobs: [], listed, since: "2026-11-01", running: new Set() }),
    ).toMatchObject({ read: 1, noJobs: 1 });
  });

  it("needs no listing for a run its own rows show was read in full, and none to doubt one that was not", () => {
    const attempts = [
      attempt(1, 1),
      // Attempt 1 of a run that was at attempt 2 when it was read, with jobs or none.
      attempt(2, 1, { latestAttempt: 2 }),
      attempt(3, 1, { latestAttempt: 2, jobCount: 1 }),
    ];
    const result = runCoverage({
      attempts,
      jobs: [],
      listed: new Map(),
      since,
      running: new Set(),
    });
    expect(result).toMatchObject({ read: 1, noJobs: 1 });
  });

  it("counts a run in `running` as running, not read, whatever its earlier attempts held", () => {
    const attempts = [attempt(1, 1, { conclusion: null }), attempt(2, 1)];
    const result = runCoverage({
      attempts,
      jobs: [],
      listed: listedAs(1, 1, 2),
      since,
      running: new Set([1]),
    });
    expect(result).toMatchObject({ read: 1, noJobs: 1, stillRunning: 1 });
  });

  it("names a run with no conclusion none, and orders conclusions most first", () => {
    const attempts = [
      attempt(1, 1, { conclusion: null }),
      attempt(2, 1, { conclusion: "startup_failure" }),
      attempt(3, 1),
      attempt(4, 1),
    ];
    const { noJobsByConclusion } = runCoverage({
      attempts,
      jobs: [],
      listed: listedAs(1, 1, 2, 3, 4),
      since,
      running: new Set(),
    });
    expect(Object.entries(noJobsByConclusion)).toEqual([
      ["cancelled", 2],
      ["none", 1],
      ["startup_failure", 1],
    ]);
  });

  it("counts a run only its jobs rows and an empty attempt 1 show was read to attempt 2", () => {
    const attempts = [attempt(1, 1, { latestAttempt: 2 })];
    const input = { attempts, listed: listedAs(2, 1), since, running: new Set<number>() };
    expect(runCoverage({ ...input, jobs: [jobOf(1, 2)] })).toMatchObject({ read: 1, noJobs: 0 });
    expect(runCoverage({ ...input, jobs: [jobOf(1, 1)] })).toMatchObject({ read: 0 });
  });

  it("leaves out a jobs-only run the listing shows at a later attempt than its jobs", () => {
    const input = { attempts: [], jobs: [jobOf(1, 1)], since, running: new Set<number>() };
    expect(runCoverage({ ...input, listed: listedAs(2, 1) })).toMatchObject({ read: 0 });
    expect(runCoverage({ ...input, listed: listedAs(1, 1) })).toMatchObject({ read: 1 });
  });
});
