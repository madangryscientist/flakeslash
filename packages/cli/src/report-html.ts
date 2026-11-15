/**
 * The local report: one self-contained HTML file with inline styles and no script, written by `scan` next
 * to the store. Pure: the caller gives the ranked issues, the excerpts by page and the time. Every piece
 * of text goes through `escapeHtml`, log text included.
 */
import type { JobExcerpt, RankedIssue, RunCoverage } from "@hackcove/flakeslash-engine";
import { coverageLine } from "./coverage-line.ts";

export interface ReportInput {
  /** The ranked issues, in rank order. */
  ranked: readonly RankedIssue[];
  /** The excerpt rows of the scanned repos, by the job's page (`url`). */
  excerpts: ReadonlyMap<string, JobExcerpt>;
  /** The repos this run scanned. */
  repos: readonly string[];
  /** The runs in the window of each repo this run scanned. */
  coverage: readonly { repo: string; coverage: RunCoverage }[];
  /** An ISO time, shown in the head. */
  now: string;
}

/** The lines of an excerpt a card shows; the rest is in the job's log on GitHub. */
const EXCERPT_LINES = 40;

/** The lines shown above the failing line, so the box opens on a little of what led to it. */
const LINES_ABOVE = 5;

/**
 * How many phone-width rows (`ROW_CHARS` characters each, about a 390px screen) the lines above the failing
 * line may take. The box's visible height is about 19 rows; long lines above the failing line wrap, and
 * without this cap five of them can push it out of the box.
 */
const ABOVE_ROWS = 12;
const ROW_CHARS = 36;

/** The PR links a card lists before it says how many more there are. */
const MAX_PRS = 5;

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes the five characters that can open a tag or an attribute. Every text the page shows goes through it. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** Seconds as minutes to one decimal place. The `--json` catalogue uses the same figure. */
export function minutesOf(seconds: number): number {
  return Math.round((seconds / 60) * 10) / 10;
}

function rateText(issue: RankedIssue): string {
  if (issue.rate === null) return "no rate";
  const count = `(${issue.flakyCommits} of ${issue.ranCommits} commits)`;
  // A rate above 0 and under 1% would round to 0%, which reads as a clean test.
  if (issue.rate > 0 && issue.rate < 0.01) return `<1% ${count}`;
  const percent = Math.round(issue.rate * 100);
  return `${percent}% ${count}`;
}

/** The first `MAX_PRS` PR links in the order `prs` has, then how many more there are. */
function prsHtml(issue: RankedIssue): string {
  if (issue.prs.length === 0) return "none";
  const links = issue.prs
    .slice(0, MAX_PRS)
    .map((pr) => {
      const href = escapeHtml(`https://github.com/${pr.repo}/pull/${pr.number}`);
      return `<a href="${href}">${escapeHtml(`${pr.repo} #${pr.number}`)}</a>`;
    })
    .join(", ");
  const more = issue.prs.length - MAX_PRS;
  return more > 0 ? `${links} and ${more} more` : links;
}

/**
 * The 0-indexed line the excerpt opens on: the first holding the failure's title, else the first holding
 * its error line; -1 when neither is found.
 */
function anchorOf(lines: readonly string[], failure: RankedIssue["latestFailure"]): number {
  if (failure === null) return -1;
  const { title, errorLine } = failure;
  if (title !== null && title !== "") {
    const at = lines.findIndex((line) => line.includes(title));
    if (at !== -1) return at;
  }
  if (errorLine === "") return -1;
  return lines.findIndex((line) => line.includes(errorLine));
}

/**
 * The excerpt lines a card shows: `EXCERPT_LINES` starting `LINES_ABOVE` above the failing line, moved up
 * so the box is full when that line is near the end, but with no more lines above it than fit in
 * `ABOVE_ROWS` phone rows. With no failing line found, the last lines, where a job's error is.
 */
function excerptWindow(excerpt: string, failure: RankedIssue["latestFailure"]): string[] {
  const lines = excerpt.split("\n");
  const anchor = anchorOf(lines, failure);
  const last = Math.max(0, lines.length - EXCERPT_LINES);
  if (anchor === -1) return lines.slice(last);
  let start = anchor;
  let rows = 0;
  const wanted = Math.min(Math.max(0, anchor - LINES_ABOVE), last);
  while (start > wanted) {
    rows += Math.max(1, Math.ceil((lines[start - 1] ?? "").length / ROW_CHARS));
    if (rows > ABOVE_ROWS) break;
    start -= 1;
  }
  return lines.slice(start, start + EXCERPT_LINES);
}

/** The card's excerpt: the latest failed job's log around the issue's failure, or a note when it is gone. */
function excerptHtml(issue: RankedIssue, excerpts: ReadonlyMap<string, JobExcerpt>): string {
  const row = issue.latestUrl === null ? undefined : excerpts.get(issue.latestUrl);
  if (row === undefined || row.status !== "kept" || row.excerpt === null) {
    return `<p class="gone">log expired</p>`;
  }
  const lines = excerptWindow(row.excerpt, issue.latestFailure).join("\n");
  return `<pre>${escapeHtml(lines)}</pre>`;
}

function explanationHtml(issue: RankedIssue): string {
  const explanation = issue.issue.explanation;
  if (explanation === null) return "";
  return `<p class="cause"><strong>${escapeHtml(explanation.component)}</strong> ${escapeHtml(
    explanation.cause,
  )}</p>`;
}

function cardHtml(issue: RankedIssue, excerpts: ReadonlyMap<string, JobExcerpt>): string {
  const tags = [`<span class="tag">${escapeHtml(issue.issue.status)}</span>`];
  if (issue.suspect) tags.push(`<span class="tag suspect">suspect</span>`);
  return [
    `<article class="issue">`,
    `<header><span class="rank">#${issue.rank}</span> <h2>${escapeHtml(issue.issue.name)}</h2></header>`,
    `<p class="tags">${tags.join(" ")}</p>`,
    `<dl class="facts">`,
    `<div><dt>Flake rate</dt><dd>${escapeHtml(rateText(issue))}</dd></div>`,
    `<div><dt>Commits, 30 days</dt><dd>${issue.commits}</dd></div>`,
    `<div><dt>Minutes lost</dt><dd>${minutesOf(issue.secondsLost)}</dd></div>`,
    `<div><dt>PRs</dt><dd>${prsHtml(issue)}</dd></div>`,
    `</dl>`,
    explanationHtml(issue),
    excerptHtml(issue, excerpts),
    `</article>`,
  ].join("\n");
}

function coverageHtml(input: ReportInput): string {
  if (input.coverage.length === 0) return "";
  const items = input.coverage.map(
    ({ repo, coverage }) =>
      `<li><strong>${escapeHtml(repo)}</strong> ${escapeHtml(coverageLine(coverage))}</li>`,
  );
  return `<ul class="coverage">\n${items.join("\n")}\n</ul>`;
}

const STYLES = `
:root {
  --bg: #fafafc;
  --fg: #1d1d26;
  --muted: #62626f;
  --card: #ffffff;
  --line: #e0e0ea;
  --code: #f2f2f7;
  --tag: #ececf4;
  --suspect: #fbe7c4;
  --suspect-fg: #6e4300;
  --link: #3b5bdb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17171e;
    --fg: #e6e6ee;
    --muted: #a0a0ae;
    --card: #20202a;
    --line: #34343f;
    --code: #15151b;
    --tag: #2c2c38;
    --suspect: #4a3816;
    --suspect-fg: #ffd997;
    --link: #8ea8ff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 72rem; margin: 0 auto; padding: 1.25rem 1rem 3rem; }
h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.1rem; margin: 0; overflow-wrap: anywhere; }
.meta { color: var(--muted); margin: 0 0 1.5rem; overflow-wrap: anywhere; }
.coverage { margin: -0.75rem 0 1.5rem; padding: 0; list-style: none; color: var(--muted); overflow-wrap: anywhere; }
.issue { background: var(--card); border: 1px solid var(--line); border-radius: 0.6rem; padding: 1rem; margin: 0 0 1rem; min-width: 0; }
.issue header { display: flex; gap: 0.6rem; align-items: baseline; min-width: 0; }
.rank { color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
.tags { margin: 0.4rem 0 0.6rem; }
.tag { display: inline-block; background: var(--tag); border-radius: 0.3rem; padding: 0 0.4rem; font-size: 0.8rem; margin-right: 0.3rem; }
.tag.suspect { background: var(--suspect); color: var(--suspect-fg); }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.5rem 1rem; margin: 0 0 0.6rem; }
.facts dt { color: var(--muted); font-size: 0.8rem; }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.cause { margin: 0.4rem 0; overflow-wrap: anywhere; }
.gone { color: var(--muted); font-style: italic; margin: 0; }
pre { background: var(--code); border-radius: 0.4rem; padding: 0.7rem; margin: 0; max-height: 24rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.45 ui-monospace, monospace; }
a { color: var(--link); }
`;

/** The whole report as one HTML document. */
export function reportHtml(input: ReportInput): string {
  const repos = input.repos.map(escapeHtml).join(", ");
  const body =
    input.ranked.length === 0
      ? `<p>No issues with a failed job in the last 30 days.</p>`
      : input.ranked.map((issue) => cardHtml(issue, input.excerpts)).join("\n");
  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>FlakeSlash report</title>`,
    `<style>${STYLES}</style>`,
    `</head>`,
    `<body>`,
    `<main>`,
    `<h1>FlakeSlash report</h1>`,
    `<p class="meta">${repos} | ${escapeHtml(input.now)}</p>`,
    coverageHtml(input),
    body,
    `</main>`,
    `</body>`,
    `</html>`,
    ``,
  ].join("\n");
}
