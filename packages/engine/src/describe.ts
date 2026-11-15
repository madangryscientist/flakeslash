/**
 * What the engine is, with no imports, so browser code can read it without pulling in the engine's
 * Node-only modules.
 */
export const ENGINE_NAME = "flakeslash-engine";

export const ENGINE_VERSION = "0.0.0";

/** What the engine is, in one line, for `--version` and logs. */
export function describeEngine(): string {
  return `${ENGINE_NAME} ${ENGINE_VERSION}`;
}
