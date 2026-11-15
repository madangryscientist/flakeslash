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
  latestFailure: null,
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

  describe("PR list", () => {
    it("lists the first 5 of 8 PRs, then says how many more", () => {
      const html = reportHtml(withPrs(8));
      expect(prLinks(html)).toEqual([1, 2, 3, 4, 5].map((n) => `acme/app #${n}`));
      expect(html).toContain("and 3 more");
    });

    it("lists all 5 of 5 PRs with no more text", () => {
      const html = reportHtml(withPrs(5));
      expect(prLinks(html)).toHaveLength(5);
      expect(html).not.toContain(" more</dd>");
      expect(html).not.toMatch(/and \d+ more/);
    });
  });

  describe("excerpt window", () => {
    /** 120 lines, `line 1` to `line 120`, with line 90 holding the failure. */
    const LOG = Array.from({ length: 120 }, (_, i) =>
      i === 89 ? "FAIL test/upload.test.ts > uploads the file" : `line ${i + 1}`,
    ).join("\n");

    it("opens 5 lines above the line holding the title, moved up so the box is full", () => {
      const shown = shownLines(LOG, { title: "uploads the file", errorLine: "not in the log" });
      expect(shown).toHaveLength(40);
      expect(shown[0]).toBe("line 81");
      expect(shown.at(-1)).toBe("line 120");
      expect(shown).toContain("FAIL test/upload.test.ts &gt; uploads the file");
    });

    it("anchors on the error line when the title is not found", () => {
      const shown = shownLines(LOG, { title: "not in the log", errorLine: "test/upload.test.ts" });
      expect(shown[0]).toBe("line 81");
      expect(shown.at(-1)).toBe("line 120");
      expect(shown).toContain("FAIL test/upload.test.ts &gt; uploads the file");
    });

    it("starts at the sixth line above when the failure is not near the end", () => {
      const early = LOG.replace("line 20\n", "Error: boom\n");
      const shown = shownLines(early, { title: null, errorLine: "Error: boom" });
      expect(shown[0]).toBe("line 15");
      expect(shown[5]).toBe("Error: boom");
      expect(shown).toHaveLength(40);
    });

    it("keeps fewer lines above the failure when they are long enough to wrap it out of the box", () => {
      const dots = ".".repeat(80);
      const long = LOG.split("\n")
        .map((line, i) => (i >= 84 && i < 89 ? dots : line))
        .join("\n");
      const shown = shownLines(long, { title: "uploads the file", errorLine: "" });
      // Each 80-character line is 3 phone rows: 4 of them make 12, the most allowed above.
      expect(shown.slice(0, 5)).toEqual([
        dots,
        dots,
        dots,
        dots,
        "FAIL test/upload.test.ts &gt; uploads the file",
      ]);
    });

    it("shows the last 40 lines with no title and an empty error line", () => {
      const shown = shownLines(LOG, { title: null, errorLine: "" });
      expect(shown).toHaveLength(40);
      expect(shown[0]).toBe("line 81");
      expect(shown.at(-1)).toBe("line 120");
    });

    it("shows the last 40 lines when nothing matches", () => {
      const shown = shownLines(LOG.replace("FAIL", "line"), null);
      expect(shown[0]).toBe("line 81");
    });
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

/** The report for the one ranked issue with PRs 1 to `count` of acme/app. */
function withPrs(count: number) {
  const prs = Array.from({ length: count }, (_, i) => ({ repo: "acme/app", number: i + 1 }));
  return { ...withRate(0.5, 1, 2), ranked: [{ ...ranked, prs }] };
}

/** The text of every PR link in the page. */
function prLinks(html: string): string[] {
  return [...html.matchAll(/<a href="https:\/\/github\.com\/[^"]*\/pull\/\d+">([^<]*)<\/a>/g)].map(
    (match) => match[1] ?? "",
  );
}

/** The lines the card's excerpt box shows for this log and failure. */
function shownLines(log: string, latestFailure: RankedIssue["latestFailure"]): string[] {
  const excerpt: JobExcerpt = {
    repo: "acme/app",
    jobId: 10,
    url: URL,
    status: "kept",
    excerpt: log,
  };
  const html = reportHtml({
    ranked: [{ ...ranked, latestFailure }],
    excerpts: new Map([[URL, excerpt]]),
    repos: ["acme/app"],
    coverage: [],
    now: "2026-12-01T00:00:00.000Z",
  });
  const match = /<pre>([\s\S]*?)<\/pre>/.exec(html);
  return (match?.[1] ?? "").split("\n");
}
