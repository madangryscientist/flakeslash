import type { GithubFetch } from "#/github/app.ts";

/** A fetch that stops at a number of requests, and says when it has. */
export interface Budgeted {
  fetch: GithubFetch;
  /** True once every request of the budget has been made. */
  spent(): boolean;
  /** The requests made so far, whatever the host. */
  used(): number;
}

/** GitHub's primary rate limit, as the engine reads one: a 403 with no requests remaining. */
function rateLimited(): Response {
  return new Response(JSON.stringify({ message: "API rate limit exceeded (the batch's budget)" }), {
    status: 403,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
  });
}

/**
 * `send` under a budget of `limit` requests. Every request it is handed counts, whatever the host, so the
 * signed log download after GitHub's 302 counts too. Once the budget is spent, every later request is
 * answered with a synthetic primary rate limit and never sent: the engine then ends its read as it does
 * for a real limit, and the App's calls fail. The request and its options pass through unchanged.
 */
export function budgeted(send: GithubFetch, limit: number): Budgeted {
  let made = 0;
  return {
    fetch: async (input, init) => {
      if (made >= limit) return rateLimited();
      made += 1;
      return send(input, init);
    },
    spent: () => made >= limit,
    used: () => made,
  };
}
