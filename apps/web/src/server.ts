import handler from "@tanstack/react-start/server-entry";
import { onCron } from "#/cron.ts";
import { startRefusal } from "#/server/env.ts";

// A production build pointed at the e2e GitHub stand-in does not start: the throw fails the
// Worker's load, so no request is served.
const refused = startRefusal();
if (refused) throw new Error(refused);

/** The Worker's entry: TanStack Start's `fetch`, and the scan (every 10 minutes) and the daily expiry on their crons. */
export default {
  fetch: (request: Request): Response | Promise<Response> => handler.fetch(request),
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext): void =>
    ctx.waitUntil(onCron(controller.cron, env)),
};
