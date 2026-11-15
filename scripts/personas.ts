// Checks docs/personas/personas.json and keeps the table in docs/personas/README.md in step with it.
//
//   bun scripts/personas.ts          rewrite the table between the markers
//   bun scripts/personas.ts --check  fail if the file is invalid or the table is stale
//
// The JSON is the source of truth. Edit, add or remove a persona there, then run this once.
// No dependencies. It also requires exactly five personas and exactly the focus keys in SUBJECTS,
// and the dash check covers the README as well as the JSON.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "docs/personas");
const jsonPath = join(dir, "personas.json");
const readmePath = join(dir, "README.md");
const START = "<!-- personas:start -->";
const END = "<!-- personas:end -->";
const PERSONA_COUNT = 5;
const SUBJECTS = ["cli", "dashboard", "report"];
const DASH = /[\u2013\u2014]/;
const CELL_BREAK = /[|\r\n]/;

type Persona = {
  id: string;
  name: string;
  group: string;
  model: string;
  profile: string;
  focus: Record<string, string>;
};
type PersonaFile = { groups: Record<string, string>; models: string[]; personas: Persona[] };
type RawFile = { groups: Record<string, string>; models: string[]; personas: unknown[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStringRecord = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every((x) => typeof x === "string");
const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const isRawFile = (v: unknown): v is RawFile =>
  isRecord(v) && isStringRecord(v.groups) && isStringList(v.models) && Array.isArray(v.personas);

function isPersona(v: unknown): v is Persona {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.group === "string" &&
    typeof v.model === "string" &&
    typeof v.profile === "string" &&
    isStringRecord(v.focus)
  );
}

// Reads the JSON into the shape the checks need. A persona that is missing a field is named
// and left out, so the checks below still run on the rest.
function parseFile(text: string): { file?: PersonaFile; errs: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { errs: [`personas.json: not valid JSON (${String(error)})`] };
  }
  if (!isRawFile(raw))
    return {
      errs: [
        "personas.json: needs groups (object of strings), models (list of strings) and personas (list)",
      ],
    };
  const personas: Persona[] = [];
  const errs: string[] = [];
  raw.personas.forEach((p, i) => {
    if (isPersona(p)) personas.push(p);
    else
      errs.push(
        `personas.json: persona #${i + 1} needs string id, name, group, model, profile and a focus object of strings`,
      );
  });
  return { file: { groups: raw.groups, models: raw.models, personas }, errs };
}

function checkCount(f: PersonaFile): string[] {
  return f.personas.length === PERSONA_COUNT
    ? []
    : [`personas.json: need exactly ${PERSONA_COUNT} personas, found ${f.personas.length}`];
}

function checkIds(f: PersonaFile): string[] {
  const seen = new Set<string>();
  const errs: string[] = [];
  for (const p of f.personas) {
    if (!/^[a-z][a-z0-9-]*$/.test(p.id)) errs.push(`persona ${p.id}: id must be lower-case kebab`);
    if (seen.has(p.id)) errs.push(`persona ${p.id}: duplicate id`);
    seen.add(p.id);
  }
  return errs;
}

function checkFocus(p: Persona): string[] {
  const keys = Object.keys(p.focus);
  const errs: string[] = [];
  const missing = SUBJECTS.filter((s) => !keys.includes(s));
  const extra = keys.filter((k) => !SUBJECTS.includes(k));
  if (missing.length > 0) errs.push(`persona ${p.id}: focus is missing ${missing.join(", ")}`);
  if (extra.length > 0) errs.push(`persona ${p.id}: focus has an unknown key ${extra.join(", ")}`);
  for (const [key, text] of Object.entries(p.focus))
    if (text.trim() === "") errs.push(`persona ${p.id}: focus ${key} is empty`);
  return errs;
}

function checkPersona(f: PersonaFile, p: Persona): string[] {
  const at = `persona ${p.id}`;
  const errs: string[] = [];
  if (p.name.trim() === "") errs.push(`${at}: name is empty`);
  if (p.profile.trim() === "") errs.push(`${at}: profile is empty`);
  if (!Object.hasOwn(f.groups, p.group)) errs.push(`${at}: group "${p.group}" is not in groups`);
  if (!f.models.includes(p.model)) errs.push(`${at}: model "${p.model}" is not in models`);
  const cells = [p.name, p.profile, ...Object.values(p.focus)];
  if (cells.some((t) => CELL_BREAK.test(t)))
    errs.push(`${at}: name, profile and focus cannot contain | or a line break`);
  return [...errs, ...checkFocus(p)];
}

function validate(f: PersonaFile): string[] {
  return [...checkCount(f), ...checkIds(f), ...f.personas.flatMap((p) => checkPersona(f, p))];
}

function checkDashes(files: [string, string][]): string[] {
  return files
    .filter(([, text]) => DASH.test(text))
    .map(([name]) => `${name}: an em or en dash is not allowed`);
}

function table(f: PersonaFile): string {
  const head = `| Persona | Group | Model | Who | ${SUBJECTS.map((s) => `Looks for (${s})`).join(" | ")} |`;
  const rule = `| --- | --- | --- | --- | ${SUBJECTS.map(() => "---").join(" | ")} |`;
  const rows = f.personas.map(
    (p) =>
      `| ${p.name} | ${f.groups[p.group]} | ${p.model} | ${p.profile} | ${SUBJECTS.map((s) => p.focus[s]).join(" | ")} |`,
  );
  return [head, rule, ...rows].join("\n");
}

function withTable(readme: string, tableText: string): string | undefined {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) return undefined;
  return `${readme.slice(0, a + START.length)}\n${tableText}\n${readme.slice(b)}`;
}

function fail(errs: string[]): number {
  console.error(errs.join("\n"));
  return 1;
}

function main(args: string[]): number {
  const jsonText = readFileSync(jsonPath, "utf8");
  const readme = readFileSync(readmePath, "utf8");
  const dashes = checkDashes([
    ["personas.json", jsonText],
    ["README.md", readme],
  ]);
  const { file, errs } = parseFile(jsonText);
  if (!file) return fail([...errs, ...dashes]);
  const problems = [...errs, ...validate(file), ...dashes];
  if (problems.length > 0) return fail(problems);
  const next = withTable(readme, table(file));
  if (next === undefined) return fail([`README.md needs ${START} and ${END} markers`]);
  if (args.includes("--check")) {
    if (next !== readme) return fail(["README.md is stale: run bun scripts/personas.ts"]);
    console.log(`ok: ${file.personas.length} personas`);
    return 0;
  }
  writeFileSync(readmePath, next);
  console.log(`wrote the table for ${file.personas.length} personas`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
