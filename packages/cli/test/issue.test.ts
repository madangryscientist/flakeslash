import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REPO,
  fakeGitHub,
  job,
  jobsOf,
  jobsPath,
  json,
  logPath,
  pullsPath,
  run,
  runsOf,
  runsPath,
  shaOf,
} from "../../engine/test/github-fake.ts";
import { openSqliteStore } from "../src/store.ts";
import { MODEL_ARGS, reply, stub } from "./model-stub.ts";
import { SINCE, playwrightLog, routesOf, text, useScan } from "./scan-harness.ts";

const SCAN_ARGS = ["scan", REPO, "--since", SINCE];
const env = { GITHUB_TOKEN: "ghp_test" };
const crash = (port: number) =>
  text(playwrightLog(["uploads a file", `Error: connect ECONNREFUSED 127.0.0.1:${port}`]));

describe("flakeslash issue", () => {
  const scan = useScan();
  const nowhere = fakeGitHub({});
  const issue = (...args: string[]) => scan.exec(["issue", ...args], nowhere);

  /** Two runs with different errors, scanned: two issues. Returns the gh stand-in and the full ids. */
  async function seeded() {
    const gh = fakeGitHub(
      routesOf(
        [REPO, 1, crash(3001)],
        [REPO, 2, text(playwrightLog(["other test", "Error: expected 1 to be 2"]))],
      ),
    );
    expect((await scan.exec(SCAN_ARGS, gh)).code).toBe(0);
    const listed: { id: string; name: string }[] = JSON.parse(
      (await issue("list", "--json")).out,
    ).issues;
    const idOf = (fragment: string) => listed.find((row) => row.name.includes(fragment))?.id ?? "";
    return { gh, crash: idOf("uploads a file"), other: idOf("other test") };
  }

  it("confirm marks the issue confirmed, and a rescan keeps it that way", async () => {
    const { gh, crash: id } = await seeded();
    const done = await issue("confirm", id.slice(0, 12));
    expect(done).toMatchObject({ code: 0, err: "" });
    expect(done.out).toBe(
      `confirmed ${id.slice(0, 16)} (e2e/upload.spec.ts:141: uploads a file)\n`,
    );

    // The same data again, then a new failure joining the issue.
    await scan.exec(SCAN_ARGS, gh);
    Object.assign(gh.routes, routesOf([REPO, 1, crash(3001)], [REPO, 3, crash(48212)]));
    gh.routes[runsPath()] = runsOf(
      run(1, "2026-11-04T00:00:00Z", { conclusion: "failure" }),
      run(3, "2026-11-04T00:00:00Z", { conclusion: "failure" }),
    );
    await scan.exec(SCAN_ARGS, gh);
    const kept = (await scan.issues()).find((one) => one.id === id);
    expect(kept).toMatchObject({ status: "confirmed", edited: false });
    expect((await scan.failures()).filter((one) => one.issueId === id)).toHaveLength(2);
  });

  it("rename sets the name, and a rescan with a model neither renames it nor sends it", async () => {
    const { gh, crash: id } = await seeded();
    const done = await issue("rename", id, "  Ship API is down  ");
    expect(done.code).toBe(0);
    expect(done.out).toBe(`renamed ${id.slice(0, 16)} to "Ship API is down"\n`);

    // The model step runs, and would name this issue too: it only gets the issue nobody edited.
    const model = stub(() => ({
      content: reply({ component: "model's name", pattern: ["expected 1 to be 2"] }),
    }));
    await scan.exec([...SCAN_ARGS, ...MODEL_ARGS], gh, env, model.fetch);
    expect(model.seen).toHaveLength(1);
    expect(model.seen[0]?.messages[1]?.content).toContain("expected 1 to be 2");
    const issues = await scan.issues();
    expect(issues.find((one) => one.id === id)).toMatchObject({
      name: "Ship API is down",
      edited: true,
      explanation: null,
    });
    expect(issues.map((one) => one.name)).toContain("model's name");
  });

  it("dismiss hides the issue from list unless --all, and a rescan keeps it dismissed and sends no model call", async () => {
    const { gh, crash: id } = await seeded();
    const done = await issue("dismiss", id.slice(0, 16));
    expect(done.out).toContain(`dismissed ${id.slice(0, 16)}`);

    const model = stub(() => ({ content: reply({ pattern: ["ECONNREFUSED"] }) }));
    await scan.exec([...SCAN_ARGS, ...MODEL_ARGS], gh, env, model.fetch);
    // The only call is for the other issue; the dismissed one is never a candidate.
    expect(model.seen).toHaveLength(1);
    expect(model.seen[0]?.messages[1]?.content).toContain("expected 1 to be 2");
    expect((await scan.issues()).find((one) => one.id === id)).toMatchObject({
      status: "dismissed",
      edited: true,
      explanation: null,
    });

    const shown = await issue("list");
    expect(shown.out).not.toContain("uploads a file");
    expect(shown.out).toContain("1 dismissed (--all shows them)");
    const all = await issue("list", "--all");
    expect(all.out).toContain(`${id.slice(0, 16)}  dismissed`);
    expect(JSON.parse((await issue("list", "--json")).out).issues).toHaveLength(1);
    expect(JSON.parse((await issue("list", "--all", "--json")).out).issues).toHaveLength(2);
  });

  it("a new failure that matches a dismissed issue joins it, and it stays dismissed even in a proven flake", async () => {
    const sha = shaOf(1);
    const gh = fakeGitHub({
      ...routesOf([REPO, 1, crash(3001)]),
    });
    await scan.exec(SCAN_ARGS, gh);
    const [first] = await scan.issues();
    const id = first?.id ?? "";
    await issue("dismiss", id);

    // Run 2 passed the same job on the same commit: run 1's failure is now part of a proven flake.
    // Run 3 is a new failure of the same crash on another port, which joins the dismissed issue.
    Object.assign(gh.routes, routesOf([REPO, 3, crash(48212)]), {
      [runsPath()]: runsOf(
        run(1, "2026-11-04T00:00:00Z", { conclusion: "failure", head_sha: sha }),
        run(2, "2026-11-04T01:00:00Z", { head_sha: sha }),
        run(3, "2026-11-04T02:00:00Z", { conclusion: "failure" }),
      ),
      [pullsPath(sha)]: json([]),
      [jobsPath(1, 1)]: jobsOf(job(10, 1, { conclusion: "failure", head_sha: sha })),
      [jobsPath(2, 1)]: jobsOf(job(20, 2, { head_sha: sha })),
      [logPath(10)]: crash(3001),
    });
    const result = await scan.exec([...SCAN_ARGS, "--json"], gh);
    expect(JSON.parse(result.out).repos[0].flakes).toHaveLength(1);

    const issues = await scan.issues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ id, status: "dismissed", edited: true });
    expect(await scan.failures()).toHaveLength(2);
    expect((await scan.failures()).every((one) => one.issueId === id)).toBe(true);
  });

  it("lists one line per issue: short id, status, kind, failures and name", async () => {
    const { crash: id } = await seeded();
    const listed = (await issue("list")).out.trimEnd().split("\n");
    expect(listed).toHaveLength(2);
    expect(listed.find((line) => line.startsWith(id.slice(0, 16)))).toBe(
      `${id.slice(0, 16)}  potential  other             1  e2e/upload.spec.ts:141: uploads a file`,
    );
    const full: { id: string }[] = JSON.parse((await issue("list", "--json")).out).issues;
    expect(full.find((row) => row.id === id)).toMatchObject({
      failures: 1,
      repos: [REPO.toLowerCase()],
    });
  });

  it("says there are no issues, and how many are dismissed", async () => {
    const { crash: one, other } = await seeded();
    await issue("dismiss", one);
    await issue("dismiss", other);
    expect((await issue("list")).out).toBe("no issues (2 dismissed; --all shows them)\n");
  });

  describe("usage errors exit 2 and name the problem", () => {
    it("a bad id: no match, too short, and ambiguous", async () => {
      await seeded();
      const missing = await issue("confirm", "key:0000000000");
      expect(missing).toMatchObject({ code: 2, out: "" });
      expect(missing.err).toContain("no issue key:0000000000");
      expect(missing.err).toContain("flakeslash issue list");

      const short = await issue("dismiss", "key:");
      expect(short.code).toBe(2);
      expect(short.err).toContain("a prefix needs 8 characters or more");

      const store = openSqliteStore(scan.storePath());
      try {
        const base = (await store.readIssues())[0];
        if (base === undefined) throw new Error("no issue");
        await store.writeIssue({ ...base, id: "key:ambiguous-one" });
        await store.writeIssue({ ...base, id: "key:ambiguous-two" });
      } finally {
        store.close();
      }
      const ambiguous = await issue("rename", "key:ambiguous", "x");
      expect(ambiguous.code).toBe(2);
      expect(ambiguous.err).toContain("key:ambiguous matches 2 issues; give more of it");
      expect((await scan.issues()).every((one) => !one.edited)).toBe(true);
    });

    it("a store that does not exist, which is not created", async () => {
      const missing = await issue("list");
      expect(missing.code).toBe(2);
      expect(missing.err).toContain(`no store at ${scan.storePath()}; run flakeslash scan first`);
      expect(existsSync(scan.storePath())).toBe(false);
    });

    it.each([
      [[], "issue needs one of list, confirm, rename or dismiss"],
      [["merge", "x"], 'unknown issue command "merge"'],
      [["confirm"], "issue confirm needs <id>"],
      [["rename", "key:aaaaaaaa"], "issue rename needs <id> <name>"],
      [["rename", "key:aaaaaaaa", "two", "words"], "(quote the name)"],
      [["dismiss", "a", "b"], 'not "b"'],
      [["list", "extra"], "issue list takes no arguments"],
      [["confirm", "key:aaaaaaaa", "--all"], 'unknown option "--all"'],
      [["list", "--bogus"], 'unknown option "--bogus"'],
      [["list", "--store"], "--store needs a value"],
    ])("%j", async (args, message) => {
      const result = await issue(...args);
      expect(result).toMatchObject({ code: 2, out: "" });
      expect(result.err).toContain(message);
    });

    it("an empty name changes nothing", async () => {
      const { crash: id } = await seeded();
      const result = await issue("rename", id, "  ");
      expect(result).toMatchObject({ code: 2, out: "" });
      expect(result.err).toContain("the new name is empty");
      expect((await scan.issues()).find((one) => one.id === id)?.edited).toBe(false);
    });
  });
});
