/**
 * The anti-slop rules Oxlint has no rule for: a TODO/FIXME with no ticket ref, and
 * commented-out code. Each project's Nx `lint` target runs it on that project's
 * dir after oxlint (`bun scripts/check-slop.ts packages/engine`); any hit fails the gate.
 */
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TODO_WITHOUT_REF = /\b(TODO|FIXME|XXX|HACK)\b(?!\s*\((?:ob\s*)?#?[\w-]*\d+\))/;
// Two signals, so prose does not trip it: a statement keyword AND a trailing ; { } or ).
const CODE_IN_COMMENT =
  /^\s*\/\/\s*(?:const|let|var|import|export|return|await|if|for|while|function|throw)\b.*[;{})]\s*$/;

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: bun scripts/check-slop.ts <dir>...");
  process.exit(2);
}
const files = roots.flatMap((root) =>
  globSync("**/*.{ts,tsx}", { cwd: root, exclude: ["**/node_modules/**"] }).map((f) =>
    join(root, f),
  ),
);

const hits: string[] = [];
for (const path of files) {
  if (path.endsWith("routeTree.gen.ts") || path === join("scripts", "check-slop.ts")) continue;
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (TODO_WITHOUT_REF.test(line))
        hits.push(`${path}:${i + 1}: TODO/FIXME needs a ticket ref, e.g. TODO(#123)`);
      if (CODE_IN_COMMENT.test(line))
        hits.push(`${path}:${i + 1}: commented-out code; delete it (git keeps it)`);
    });
}
if (hits.length > 0) {
  console.error(hits.join("\n"));
  process.exit(1);
}
