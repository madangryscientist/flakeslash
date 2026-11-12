import {
  isRepoName,
  type FetchLike,
  type ModelClientOptions,
  type ModelFetch,
} from "@hackcove/flakeslash-engine";
import pkg from "../package.json" with { type: "json" };
import { UsageError } from "./usage-error.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SINCE_DAYS = 90;

/** What the CLI reaches outside itself through, so a test can stand in for the network and the shell. */
export interface Deps {
  fetch: FetchLike;
  /** The model endpoint's POST; the real `fetch` unless a test stands in. */
  modelFetch?: ModelFetch;
  env: Readonly<Record<string, string | undefined>>;
}

/** The model endpoint a scan may call: everything `createModelClient` needs but the fetch. */
export type ModelConfig = Omit<ModelClientOptions, "fetch">;

export interface ScanArgs {
  repos: string[];
  since: string;
  store: string | undefined;
  json: boolean;
  /** Undefined when no endpoint is named. */
  model: ModelConfig | undefined;
}

/** The model flags that mean nothing without an endpoint, in the order they are checked. */
const MODEL_FLAGS: readonly string[] = ["--model", "--cap-usd", "--price-in", "--price-out"];
/** Every scan flag that takes a value. */
const VALUE_FLAGS: readonly string[] = ["--since", "--store", "--model-url", ...MODEL_FLAGS];

function sinceFrom(since: string | undefined): string {
  if (since === undefined) return new Date(Date.now() - DEFAULT_SINCE_DAYS * DAY_MS).toISOString();
  const ms = Date.parse(since);
  if (Number.isNaN(ms)) throw new UsageError(`--since "${since}" is not a date`);
  return new Date(ms).toISOString();
}

/** A number flag's value, which must be finite and pass `allowed` (described by `rule`). */
function numberFlag(
  values: ReadonlyMap<string, string>,
  flag: string,
  allowed: (n: number) => boolean,
  rule: string,
): number {
  const value = values.get(flag) ?? "";
  const number = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(number)) throw new UsageError(`${flag} "${value}" is not a number`);
  if (!allowed(number)) throw new UsageError(`${flag} "${value}" must be ${rule}`);
  return number;
}

function urlFrom(value: string): string {
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new UsageError("--model-url is not a URL");
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new UsageError("--model-url must start with http:// or https://");
  }
  return value;
}

/** `Name: value` per line. A bad line is named by its number only: its text may hold a secret. */
function headersFrom(text: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (text === undefined) return headers;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    const name = colon < 0 ? "" : line.slice(0, colon).trim();
    if (name === "") {
      throw new UsageError(`FLAKESLASH_MODEL_HEADERS line ${index + 1} is not "Name: value"`);
    }
    headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** The endpoint named by the flag, else by FLAKESLASH_MODEL_URL; an empty value counts as unset. */
function endpointFrom(values: ReadonlyMap<string, string>, env: Deps["env"]): string | undefined {
  const named = values.get("--model-url") ?? env.FLAKESLASH_MODEL_URL;
  return named === undefined || named === "" ? undefined : named;
}

function modelFrom(values: ReadonlyMap<string, string>, env: Deps["env"]): ModelConfig | undefined {
  const url = endpointFrom(values, env);
  if (url === undefined) {
    const stray = MODEL_FLAGS.find((flag) => values.has(flag));
    if (stray !== undefined) throw new UsageError(`${stray} needs --model-url`);
    return undefined;
  }
  const baseUrl = urlFrom(url);
  for (const flag of MODEL_FLAGS) {
    if (!values.has(flag)) throw new UsageError(`${flag} is required with --model-url`);
  }
  return {
    url: baseUrl,
    key: env.FLAKESLASH_MODEL_KEY === "" ? undefined : env.FLAKESLASH_MODEL_KEY,
    model: values.get("--model") ?? "",
    capUsd: numberFlag(values, "--cap-usd", (n) => n > 0, "above 0"),
    priceIn: numberFlag(values, "--price-in", (n) => n >= 0, "0 or more"),
    priceOut: numberFlag(values, "--price-out", (n) => n >= 0, "0 or more"),
    headers: headersFrom(env.FLAKESLASH_MODEL_HEADERS),
    userAgent: `flakeslash/${pkg.version}`,
  };
}

/** Splits argv into repos, the flags that take a value, and --json. */
function readArgs(args: readonly string[]) {
  const repos: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") json = true;
    else if (VALUE_FLAGS.includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${arg} needs a value`);
      }
      values.set(arg, value);
      index += 1;
    } else if (arg.startsWith("-")) throw new UsageError(`unknown option "${arg}"`);
    else repos.push(arg);
  }
  return { repos, values, json };
}

export function parseScanArgs(args: readonly string[], env: Deps["env"] = {}): ScanArgs {
  const { repos, values, json } = readArgs(args);
  if (repos.length === 0) throw new UsageError("scan needs at least one repo, as owner/name");
  for (const repo of repos) {
    if (!isRepoName(repo)) throw new UsageError(`"${repo}" is not a repo; write it as owner/name`);
  }
  return {
    repos,
    since: sinceFrom(values.get("--since")),
    store: values.get("--store"),
    json,
    model: modelFrom(values, env),
  };
}
