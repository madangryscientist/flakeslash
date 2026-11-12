import { describe, expect, it } from "vitest";
import { REPO, fakeGitHub } from "../../engine/test/github-fake.ts";
import { SINCE, playwrightLog, routesOf, text, useScan } from "./scan-harness.ts";

const SCAN_ARGS = ["scan", REPO, "--since", SINCE];
const crash = (port: number) =>
  text(playwrightLog(["uploads a file", `Error: connect ECONNREFUSED 127.0.0.1:${port}`]));

/** A run of `REPO` with this id and log, for `routesOf`. */
const runOn = (runId: number, log: Response): [string, number, Response] => [REPO, runId, log];

describe("flakeslash issue merge and split", () => {
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
    await scan.exec(SCAN_ARGS, gh);
    const listed: { id: string; name: string }[] = JSON.parse(
      (await issue("list", "--json")).out,
    ).issues;
    const idOf = (fragment: string) => listed.find((row) => row.name.includes(fragment))?.id ?? "";
    return { gh, crash: idOf("uploads a file"), other: idOf("other test") };
  }

  it("merge keeps both signatures on the first issue, and a rescan keeps it that way", async () => {
    const { gh, crash: id, other } = await seeded();
    const done = await issue("merge", id.slice(0, 12), other.slice(0, 12));
    expect(done).toMatchObject({ code: 0, err: "" });
    expect(done.out).toBe(
      `merged ${other.slice(0, 16)} into ${id.slice(0, 16)} (e2e/upload.spec.ts:141: uploads a file)\n`,
    );
    expect(JSON.parse((await issue("list", "--json")).out).issues).toHaveLength(1);

    // A new failure matching each old signature: both join the merged issue.
    Object.assign(
      gh.routes,
      routesOf(
        runOn(1, crash(3001)),
        runOn(2, text(playwrightLog(["other test", "Error: expected 1 to be 2"]))),
        runOn(3, crash(48212)),
        runOn(4, text(playwrightLog(["other test", "Error: expected 1 to be 2"]))),
      ),
    );
    await scan.exec(SCAN_ARGS, gh);
    const issues = await scan.issues();
    expect(issues.map((one) => one.id)).toEqual([id]);
    expect(issues[0]?.signatures).toHaveLength(2);
    expect((await scan.failures()).filter((one) => one.issueId === id)).toHaveLength(4);
    expect(JSON.parse((await issue("list", "--json")).out).issues).toHaveLength(1);
  });

  it("merging a starter issue into a key issue: a later starter match joins the survivor, and no starter issue comes back", async () => {
    const gh = fakeGitHub(
      routesOf(
        runOn(1, crash(3001)),
        runOn(2, text(playwrightLog(["other test", "Error: Page crashed"]))),
      ),
    );
    await scan.exec(SCAN_ARGS, gh);
    const before = await scan.issues();
    const crashId = before.find((one) => one.name.includes("uploads a file"))?.id ?? "";
    const starterId = before.find((one) => one.id.startsWith("starter:"))?.id ?? "";
    expect(starterId).toBe("starter:Page crashed");

    expect((await issue("merge", crashId, starterId)).code).toBe(0);
    expect((await scan.issues()).map((one) => one.id)).toEqual([crashId]);

    Object.assign(
      gh.routes,
      routesOf(
        runOn(1, crash(3001)),
        runOn(2, text(playwrightLog(["other test", "Error: Page crashed"]))),
        runOn(3, text(playwrightLog(["more", "Error: Page crashed again"]))),
      ),
    );
    await scan.exec(SCAN_ARGS, gh);
    expect((await scan.issues()).map((one) => one.id)).toEqual([crashId]);
    expect((await scan.failures()).filter((one) => one.issueId === crashId)).toHaveLength(3);
  });

  it("split moves the failures that contain the text to a new issue, and a rescan keeps each on its side", async () => {
    const { gh, crash: id, other } = await seeded();
    await issue("merge", id, other);

    const done = await issue("split", id, "--signature", "ECONNREFUSED");
    expect(done).toMatchObject({ code: 0, err: "" });
    expect(done.out).toMatch(
      new RegExp(
        `^split 1 failures from ${id.slice(0, 16)} into split:[0-9a-f]{10} \\(ECONNREFUSED\\)\n$`,
      ),
    );
    const splitId = (await scan.issues()).find((one) => one.id.startsWith("split:"))?.id ?? "";
    expect(splitId).toMatch(/^split:[0-9a-f]{64}$/);
    const failuresOf = async (issueId: string) =>
      (await scan.failures()).filter((one) => one.issueId === issueId).map((one) => one.errorLine);
    expect(await failuresOf(splitId)).toEqual(["Error: connect ECONNREFUSED 127.0.0.1:3001"]);
    expect(await failuresOf(id)).toEqual(["Error: expected 1 to be 2"]);
    expect((await scan.issues()).find((one) => one.id === splitId)).toMatchObject({
      status: "potential",
      edited: true,
      explanation: null,
    });

    // A new crash on another port joins the split; a new "expected" failure stays on the source.
    Object.assign(
      gh.routes,
      routesOf(
        runOn(1, crash(3001)),
        runOn(2, text(playwrightLog(["other test", "Error: expected 1 to be 2"]))),
        runOn(3, crash(48212)),
        runOn(4, text(playwrightLog(["other test", "Error: expected 1 to be 2"]))),
      ),
    );
    await scan.exec(SCAN_ARGS, gh);
    expect(await failuresOf(splitId)).toHaveLength(2);
    expect(await failuresOf(id)).toHaveLength(2);
    expect((await scan.issues()).map((one) => one.id)).toEqual(
      expect.arrayContaining([id, splitId]),
    );
  });

  describe("usage errors exit 2 and name the problem", () => {
    it("merge and split with a bad id, the same issue twice, or no match: exit 2, nothing changes", async () => {
      const { crash: id } = await seeded();
      const before = JSON.stringify([await scan.issues(), await scan.failures()]);
      const cases: [string[], string][] = [
        [["merge", "key:0000000000", id], "no issue key:0000000000"],
        [["merge", id, "key:0000000000"], "no issue key:0000000000"],
        [["merge", id, id.slice(0, 12)], "cannot merge an issue with itself"],
        [["split", "key:0000000000", "--signature", "x"], "no issue key:0000000000"],
        [
          ["split", id, "--signature", "no such text"],
          `no failure of issue ${id} contains "no such text"`,
        ],
        [["split", id, "--signature", "   "], "the split signature is empty"],
      ];
      for (const [args, message] of cases) {
        const result = await issue(...args);
        expect(result.code).toBe(2);
        expect(result.out).toBe("");
        expect(result.err).toContain(message);
      }
      expect(JSON.stringify([await scan.issues(), await scan.failures()])).toBe(before);
    });
  });
});
