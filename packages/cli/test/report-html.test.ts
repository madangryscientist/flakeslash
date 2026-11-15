import type { JobExcerpt, RankedIssue } from "@hackcove/flakeslash-engine";
import { describe, expect, it } from "vitest";
import { reportHtml } from "../src/report-html.ts";

const URL = "https://github.com/acme/app/actions/runs/1/job/10";

const ranked: RankedIssue = {
  rank: 1,
  issue: {
    id: "key:boom",
    name: "<b>boom</b> in the upload",
    kind: "other",
    status: "potential",
    signatures: [],
    explanation: null,
    edited: false,
  },
  commits: 2,
  secondsLost: 90,
  prs: [{ repo: "acme/app", number: 7 }],
  rate: 0.5,
  flakyCommits: 1,
  ranCommits: 2,
  suspect: false,
  latestUrl: URL,
};

describe("reportHtml", () => {
  it("shows log text as text: an excerpt holding a script tag is escaped and no script runs", () => {
    const excerpt: JobExcerpt = {
      repo: "acme/app",
      jobId: 10,
      url: URL,
      status: "kept",
      excerpt: "Error: <script>alert(1)</script>\nexpected & received",
    };
    const html = reportHtml({
      ranked: [ranked],
      excerpts: new Map([[URL, excerpt]]),
      repos: ["acme/app"],
      coverage: [],
      now: "2026-12-01T00:00:00.000Z",
    });

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("expected &amp; received");
    expect(html).toContain("&lt;b&gt;boom&lt;/b&gt; in the upload");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>boom");
  });

  it("says log expired when the excerpt is gone", () => {
    const html = reportHtml({
      ranked: [ranked],
      excerpts: new Map([
        [URL, { repo: "acme/app", jobId: 10, url: URL, status: "gone", excerpt: null }],
      ]),
      repos: ["acme/app"],
      coverage: [],
      now: "2026-12-01T00:00:00.000Z",
    });

    expect(html).toContain("log expired");
    expect(html).toContain("50% (1 of 2 commits)");
  });

  it("carries a dark colour scheme that redefines the page's colour tokens", () => {
    const html = reportHtml({
      ranked: [ranked],
      excerpts: new Map(),
      repos: ["acme/app"],
      coverage: [],
      now: "2026-12-01T00:00:00.000Z",
    });

    expect(html).toContain("@media (prefers-color-scheme: dark)");
    const dark = html.slice(html.indexOf("@media (prefers-color-scheme: dark)"));
    for (const token of ["--bg:", "--fg:", "--muted:", "--line:", "--code:", "--link:"]) {
      expect(dark).toContain(token);
    }
  });

  describe("flake rate text", () => {
    it("prints <1% for a rate above 0 and under 1%, with the count beside it", () => {
      expect(rateLine(1 / 348, 1, 348)).toBe("&lt;1% (1 of 348 commits)");
      expect(rateLine(0.004, 2, 500)).toBe("&lt;1% (2 of 500 commits)");
      expect(rateLine(0.009, 9, 1000)).toBe("&lt;1% (9 of 1000 commits)");
    });

    it("prints 0% for a rate of exactly 0", () => {
      expect(rateLine(0, 0, 573)).toBe("0% (0 of 573 commits)");
    });

    it("rounds from 1% up as before", () => {
      expect(rateLine(0.01, 1, 100)).toBe("1% (1 of 100 commits)");
      expect(rateLine(0.016, 16, 1000)).toBe("2% (16 of 1000 commits)");
    });

    it("keeps no rate when there is no rate", () => {
      expect(reportHtml(withRate(null, 0, 0))).toContain("<dd>no rate</dd>");
    });
  });
});

/** The report for the one ranked issue with this rate, with its count. */
function withRate(rate: number | null, flakyCommits: number, ranCommits: number) {
  return {
    ranked: [{ ...ranked, rate, flakyCommits, ranCommits }],
    excerpts: new Map(),
    repos: ["acme/app"],
    coverage: [],
    now: "2026-12-01T00:00:00.000Z",
  };
}

/** The flake rate line the report shows for this rate and count. */
function rateLine(rate: number, flakyCommits: number, ranCommits: number): string {
  const match = /<dd>([^<]*commits\))<\/dd>/.exec(
    reportHtml(withRate(rate, flakyCommits, ranCommits)),
  );
  return match?.[1] ?? "";
}
