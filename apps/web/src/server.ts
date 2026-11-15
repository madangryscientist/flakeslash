import handler from "@tanstack/react-start/server-entry";
import { scheduled } from "#/scan/hourly.ts";
import { startRefusal } from "#/server/env.ts";

// A production build pointed at the e2e GitHub stand-in does not start: the throw fails the
// Worker's load, so no request is served.
const refused = startRefusal();
if (refused) throw new Error(refused);

/** The Worker's entry: TanStack Start's `fetch`, and the hourly scan on the cron. */
export default {
  fetch: (request: Request): Response | Promise<Response> => handler.fetch(request),
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext): void =>
    ctx.waitUntil(scheduled(env)),
};
