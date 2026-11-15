/**
 * D1 allows 50 queries per Worker invocation on the free plan (1,000 paid). The batch's bounds keep
 * it under that on the measured cases, but what a scan writes per log grows with the distinct failures
 * in it (a new issue each), which no request budget bounds. So the batch's D1 handle refuses statements
 * past the cap, the `SCAN_D1_CAP` var: the scan in progress throws and is logged, what it wrote stays,
 * and the next batch carries on. This is the cap when the var is unset or not a positive whole number.
 */
export const D1_STATEMENT_CAP = 950;

/** The cap from the `SCAN_D1_CAP` var, or `D1_STATEMENT_CAP` when it is unset or invalid. */
export function d1CapOf(env: { SCAN_D1_CAP?: number | string }): number {
  const n = Number(env.SCAN_D1_CAP);
  return Number.isInteger(n) && n > 0 ? n : D1_STATEMENT_CAP;
}

/** The batch reached its D1 statement cap: an expected stop, not a failure. */
export class D1CapReached extends Error {
  constructor(cap: number) {
    super(`the batch reached its cap of ${cap} D1 statements`);
    this.name = "D1CapReached";
  }
}

/** Whether `error`, or an error it wraps (Drizzle wraps a failed query), is the cap. */
export function isCapReached(error: unknown): boolean {
  for (let at: unknown = error; at instanceof Error; at = at.cause) {
    if (at instanceof D1CapReached) return true;
  }
  return false;
}

/**
 * `d1` with every `prepare` counted (Drizzle prepares each statement it runs, in a batch or not), and
 * refused once `cap` have been prepared.
 */
export function capStatements(d1: D1Database, cap: number): D1Database {
  let prepared = 0;
  return new Proxy(d1, {
    get(target, name) {
      if (name !== "prepare") {
        const value: unknown = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (query: string) => {
        if (prepared >= cap) throw new D1CapReached(cap);
        prepared += 1;
        return target.prepare(query);
      };
    },
  });
}
