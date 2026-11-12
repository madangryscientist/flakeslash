import {
  IssueError,
  confirmIssue,
  dismissIssue,
  listIssues,
  mergeIssues,
  renameIssue,
  splitIssue,
  type Issue,
  type IssueStore,
  type IssueSummary,
} from "@hackcove/flakeslash-engine";
import { existsSync } from "node:fs";
import { DEFAULT_STORE_PATH, openSqliteStore } from "./store.ts";
import { UsageError } from "./usage-error.ts";

/** How many characters of an id `issue list` shows: `key:` and 12 hex, which `findIssue` accepts. */
const SHORT_ID = 16;

/** The `issue` usage lines of `flakeslash --help`. */
export const ISSUE_USAGE = `  flakeslash issue list [--all] [--json] [--store <path>]
                         list the issues the store holds, most failures first
  flakeslash issue confirm|dismiss <id> [--store <path>]
  flakeslash issue rename <id> <name> [--store <path>]
  flakeslash issue merge <id> <id> [--store <path>]
                         fold the second issue into the first, keeping both signatures
  flakeslash issue split <id> --signature <text> [--store <path>]
                         move the failures that contain the text into a new issue named by it
`;

/** The notes on the `issue` commands in `flakeslash --help`, after the scan notes. */
export const ISSUE_HELP = `issue corrects one catalogue entry, and the correction survives every later scan. confirm marks the
issue a real flake, dismiss hides it (a new failure that matches it still joins it, and it stays
hidden), and rename sets its name (quote it; the model never renames it again). merge folds the second
issue into the first, so new failures that match either one join the first. split moves the failures
whose match text contains the text (the error line for a test, else the log excerpt) into a new issue,
whose pattern is that text. <id> is the full id or any prefix of 8 or more characters that matches one
issue; list shows the first 16 characters.
Options for issue list:
  --all     also show dismissed issues
  --json    write { "issues": [...] } with full ids to stdout
Option for issue split:
  --signature <text>   the text to split on (required; quote it if it has spaces)
`;

type Action = "list" | "confirm" | "rename" | "dismiss" | "merge" | "split";

const ACTIONS: readonly Action[] = ["list", "confirm", "rename", "dismiss", "merge", "split"];

/** How many arguments after the action each one takes. */
const OPERANDS: Record<Action, number> = {
  list: 0,
  confirm: 1,
  dismiss: 1,
  rename: 2,
  merge: 2,
  split: 1,
};
const OPERAND_NAMES: Record<Action, string> = {
  list: "",
  confirm: "<id>",
  dismiss: "<id>",
  rename: "<id> <name>",
  merge: "<id> <id>",
  split: "<id>",
};

interface IssueArgs {
  action: Action;
  /** The ids, or the id and the new name for `rename`. */
  operands: string[];
  /** The text `split` moves failures by. */
  signature: string | undefined;
  store: string | undefined;
  all: boolean;
  json: boolean;
}

function actionOf(value: string | undefined): Action {
  const action = ACTIONS.find((known) => known === value);
  if (action === undefined) {
    throw new UsageError(
      value === undefined || value.startsWith("-")
        ? "issue needs one of list, confirm, rename, dismiss, merge or split"
        : `unknown issue command "${value}"; use list, confirm, rename, dismiss, merge or split`,
    );
  }
  return action;
}

interface Flags {
  store: string | undefined;
  all: boolean;
  json: boolean;
  signature: string | undefined;
}

/** The argument after the flag at `index`. `--store` refuses a value that starts with `--`; a text may. */
function valueAfter(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || (flag === "--store" && value.startsWith("--"))) {
    throw new UsageError(`${flag} needs a value`);
  }
  return value;
}

/** Applies the flag at `args[index]` to `flags` and returns how many arguments it used, or 0 if it is no flag. */
function applyFlag(action: Action, args: readonly string[], index: number, flags: Flags): number {
  const arg = args[index] ?? "";
  if (arg === "--store") {
    flags.store = valueAfter(args, index, arg);
    return 2;
  }
  // The next argument is the text whatever it starts with, so `--signature "--- FAIL"` works.
  if (action === "split" && arg === "--signature") {
    flags.signature = valueAfter(args, index, arg);
    return 2;
  }
  if (action === "list" && arg === "--all") flags.all = true;
  else if (action === "list" && arg === "--json") flags.json = true;
  else if (arg.startsWith("-")) throw new UsageError(`unknown option "${arg}"`);
  else return 0;
  return 1;
}

/** Splits the arguments after the action into operands and flags. `--all` and `--json` are for list. */
function readIssueFlags(action: Action, args: readonly string[]) {
  const operands: string[] = [];
  const flags: Flags = { store: undefined, all: false, json: false, signature: undefined };
  let index = 0;
  while (index < args.length) {
    const used = applyFlag(action, args, index, flags);
    if (used === 0) operands.push(args[index] ?? "");
    index += Math.max(used, 1);
  }
  return { operands, ...flags };
}

function checkOperands(action: Action, operands: readonly string[]): void {
  const wanted = OPERANDS[action];
  if (operands.length < wanted) {
    throw new UsageError(`issue ${action} needs ${OPERAND_NAMES[action]}`);
  }
  if (operands.length > wanted) {
    const hint = action === "rename" ? " (quote the name)" : "";
    const given = wanted === 0 ? "no arguments" : OPERAND_NAMES[action];
    throw new UsageError(
      `issue ${action} takes ${given}, not "${operands.slice(wanted).join(" ")}"${hint}`,
    );
  }
}

function parseIssueArgs(args: readonly string[]): IssueArgs {
  const action = actionOf(args[0]);
  const read = readIssueFlags(action, args.slice(1));
  checkOperands(action, read.operands);
  if (action === "split" && read.signature === undefined) {
    throw new UsageError("issue split needs --signature <text>");
  }
  return { action, ...read };
}

function listLine(row: IssueSummary): string {
  const id = row.id.slice(0, SHORT_ID).padEnd(SHORT_ID);
  return `${id}  ${row.status.padEnd(9)}  ${row.kind.padEnd(13)}  ${String(row.failures).padStart(4)}  ${row.name}`;
}

function listText(rows: readonly IssueSummary[], hidden: number): string {
  if (rows.length === 0) {
    return hidden > 0 ? `no issues (${hidden} dismissed; --all shows them)\n` : "no issues\n";
  }
  const lines = rows.map(listLine);
  if (hidden > 0) lines.push(`${hidden} dismissed (--all shows them)`);
  return `${lines.join("\n")}\n`;
}

async function listCommand(options: IssueArgs, store: IssueStore) {
  const every = await listIssues(store, { all: true });
  const rows = options.all ? every : every.filter((row) => row.status !== "dismissed");
  if (options.json) process.stdout.write(`${JSON.stringify({ issues: rows })}\n`);
  else process.stdout.write(listText(rows, every.length - rows.length));
}

function editLine(action: Action, issue: Issue): string {
  const id = issue.id.slice(0, SHORT_ID);
  if (action === "confirm") return `confirmed ${id} (${issue.name})\n`;
  if (action === "dismiss") return `dismissed ${id} (${issue.name})\n`;
  return `renamed ${id} to "${issue.name}"\n`;
}

async function runAction(options: IssueArgs, store: IssueStore): Promise<void> {
  const [id = "", name = ""] = options.operands;
  if (options.action === "list") await listCommand(options, store);
  else if (options.action === "confirm") {
    process.stdout.write(editLine("confirm", await confirmIssue(store, id)));
  } else if (options.action === "dismiss") {
    process.stdout.write(editLine("dismiss", await dismissIssue(store, id)));
  } else if (options.action === "merge") {
    const [, other = ""] = options.operands;
    const { survivor, merged } = await mergeIssues(store, id, other);
    const into = survivor.id.slice(0, SHORT_ID);
    process.stdout.write(
      `merged ${merged.id.slice(0, SHORT_ID)} into ${into} (${survivor.name})\n`,
    );
  } else if (options.action === "split") {
    const { source, created, moved } = await splitIssue(store, id, options.signature ?? "");
    process.stdout.write(
      `split ${moved} failures from ${source.id.slice(0, SHORT_ID)} into ${created.id.slice(0, SHORT_ID)} (${created.name})\n`,
    );
  } else process.stdout.write(editLine("rename", await renameIssue(store, id, name)));
}

/** Runs `flakeslash issue ...` and returns the exit code: 0 ok, 2 a usage error. */
export async function issueCommand(args: readonly string[]): Promise<number> {
  try {
    const options = parseIssueArgs(args);
    const path = options.store ?? DEFAULT_STORE_PATH;
    if (!existsSync(path)) {
      throw new UsageError(`no store at ${path}; run flakeslash scan first`);
    }
    const store = openSqliteStore(path);
    try {
      await runAction(options, store);
    } finally {
      store.close();
    }
    return 0;
  } catch (error) {
    if (!(error instanceof UsageError) && !(error instanceof IssueError)) throw error;
    const hint = error instanceof UsageError ? ". Try --help." : "";
    process.stderr.write(`flakeslash: ${error.message}${hint}\n`);
    return 2;
  }
}
