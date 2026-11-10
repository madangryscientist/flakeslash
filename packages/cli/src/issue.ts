import {
  IssueError,
  confirmIssue,
  dismissIssue,
  listIssues,
  renameIssue,
  type Issue,
  type IssueStore,
  type IssueSummary,
} from "@hackcove/flakeslash-engine";
import { existsSync } from "node:fs";
import { DEFAULT_STORE_PATH, openSqliteStore } from "./store.ts";
import { UsageError } from "./usage-error.ts";

/** How many characters of an id `issue list` shows: `key:` and 12 hex, which `findIssue` accepts. */
const SHORT_ID = 16;

type Action = "list" | "confirm" | "rename" | "dismiss";

const ACTIONS: readonly Action[] = ["list", "confirm", "rename", "dismiss"];

/** How many arguments after the action each one takes. */
const OPERANDS: Record<Action, number> = { list: 0, confirm: 1, dismiss: 1, rename: 2 };
const OPERAND_NAMES: Record<Action, string> = {
  list: "",
  confirm: "<id>",
  dismiss: "<id>",
  rename: "<id> <name>",
};

interface IssueArgs {
  action: Action;
  /** The id, then the new name for `rename`. */
  operands: string[];
  store: string | undefined;
  all: boolean;
  json: boolean;
}

function actionOf(value: string | undefined): Action {
  const action = ACTIONS.find((known) => known === value);
  if (action === undefined) {
    throw new UsageError(
      value === undefined || value.startsWith("-")
        ? "issue needs one of list, confirm, rename or dismiss"
        : `unknown issue command "${value}"; use list, confirm, rename or dismiss`,
    );
  }
  return action;
}

interface Flags {
  store: string | undefined;
  all: boolean;
  json: boolean;
}

/** Applies the flag at `args[index]` to `flags` and returns how many arguments it used, or 0 if it is no flag. */
function applyFlag(action: Action, args: readonly string[], index: number, flags: Flags): number {
  const arg = args[index] ?? "";
  if (arg === "--store") {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new UsageError("--store needs a value");
    flags.store = value;
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
  const flags: Flags = { store: undefined, all: false, json: false };
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
