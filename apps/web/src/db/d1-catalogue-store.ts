/** The issue, failure and model call methods of `d1Store`, and the merge of issues. */
import { and, asc, eq } from "drizzle-orm";
import type { Issue, Store } from "@hackcove/flakeslash-engine";
import { runBatch, upsertAll, upserts, type Scope, type Statement } from "./d1-store-shared.ts";
import { failureFromRow, issueFromRow, outcomeOf } from "./rows.ts";
import { failures, issues, modelCalls } from "./schema.ts";

function issueRow(own: Scope["own"], issue: Issue): typeof issues.$inferInsert {
  return {
    ...own,
    ...issue,
    signatures: JSON.stringify(issue.signatures),
    explanation: issue.explanation === null ? null : JSON.stringify(issue.explanation),
  };
}

const ISSUE_KEY = [issues.orgId, issues.id];

function issueMethods(scope: Scope): Pick<Store, "readIssues" | "writeIssue" | "mergeIssues"> {
  const { db, q, orgId, own } = scope;
  return {
    async readIssues() {
      const rows = await q
        .select()
        .from(issues)
        .where(eq(issues.orgId, orgId))
        .orderBy(asc(issues.id));
      return rows.map(issueFromRow);
    },
    async writeIssue(issue) {
      await upsertAll(scope, issues, ISSUE_KEY, [issueRow(own, issue)]);
    },
    async mergeIssues(survivor, mergedIds) {
      const moves = mergedIds.flatMap((id): Statement[] => [
        q
          .update(failures)
          .set({ issueId: survivor.id })
          .where(and(eq(failures.orgId, orgId), eq(failures.issueId, id))),
        q
          .update(modelCalls)
          .set({ issueId: survivor.id })
          .where(and(eq(modelCalls.orgId, orgId), eq(modelCalls.issueId, id))),
        q.delete(issues).where(and(eq(issues.orgId, orgId), eq(issues.id, id))),
      ]);
      // One batch, so the merge is all or nothing.
      await runBatch(db, [...upserts(q, issues, ISSUE_KEY, [issueRow(own, survivor)]), ...moves]);
    },
  };
}

function failureMethods(
  scope: Scope,
): Pick<Store, "writeFailures" | "failureJobIds" | "readFailures"> {
  const { q, orgId, own } = scope;
  return {
    async writeFailures(written) {
      await upsertAll(
        scope,
        failures,
        [failures.orgId, failures.repo, failures.jobId, failures.signature],
        written.map((failure) => ({ ...own, ...failure })),
      );
    },
    async failureJobIds(repo) {
      const rows = await q
        .selectDistinct({ jobId: failures.jobId })
        .from(failures)
        .where(and(eq(failures.orgId, orgId), eq(failures.repo, repo)))
        .orderBy(asc(failures.jobId));
      return rows.map((row) => row.jobId);
    },
    async readFailures() {
      const rows = await q
        .select()
        .from(failures)
        .where(eq(failures.orgId, orgId))
        .orderBy(asc(failures.repo), asc(failures.jobId), asc(failures.signature));
      return rows.map(failureFromRow);
    },
  };
}

function modelCallMethods(scope: Scope): Pick<Store, "writeModelCall" | "readModelCalls"> {
  const { q, orgId, own } = scope;
  return {
    async writeModelCall(call) {
      await upsertAll(
        scope,
        modelCalls,
        [modelCalls.orgId, modelCalls.repo, modelCalls.jobId],
        [{ ...own, ...call }],
      );
    },
    async readModelCalls() {
      const rows = await q
        .select()
        .from(modelCalls)
        .where(eq(modelCalls.orgId, orgId))
        .orderBy(asc(modelCalls.repo), asc(modelCalls.jobId));
      return rows.map((row) => ({
        repo: row.repo,
        jobId: row.jobId,
        issueId: row.issueId,
        outcome: outcomeOf(row.outcome),
      }));
    },
  };
}

export function catalogueMethods(
  scope: Scope,
): ReturnType<typeof issueMethods> &
  ReturnType<typeof failureMethods> &
  ReturnType<typeof modelCallMethods> {
  return { ...issueMethods(scope), ...failureMethods(scope), ...modelCallMethods(scope) };
}
