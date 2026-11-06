/** The machine class a job ran on. Provider is a separate field: all of these are `github-actions`. */
export type Runner = "github-hosted" | "depot" | "blacksmith" | "self-hosted";

/**
 * Runner from a job's `runs-on` labels. Depot and Blacksmith are told apart by their documented label
 * prefixes (`depot-ubuntu-24.04-4`, `blacksmith-4vcpu-ubuntu-2404`); those two are not yet checked
 * against a real run. `self-hosted` is the label GitHub itself adds. Anything else, including no
 * labels, is a GitHub-hosted runner (`ubuntu-latest`, `windows-2022`, ...).
 */
export function runnerFromLabels(labels: readonly string[]): Runner {
  const lower = labels.map((label) => label.toLowerCase());
  if (lower.some((label) => label.startsWith("depot-"))) return "depot";
  if (lower.some((label) => label.startsWith("blacksmith-"))) return "blacksmith";
  if (lower.includes("self-hosted")) return "self-hosted";
  return "github-hosted";
}
