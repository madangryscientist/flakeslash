import { createFileRoute } from "@tanstack/react-router";
import { deleteCookie, getCookie } from "@tanstack/react-start/server";
import { exchangeCode, readProfile } from "#/auth/github.ts";
import { githubCallback } from "#/auth/sign-in-github.ts";
import { signInGithubUser } from "#/db/users.ts";
import { database, githubConfig } from "#/server/env.ts";
import { startSession } from "#/server/session.ts";

export const Route = createFileRoute("/auth/github/callback")({
  server: {
    handlers: {
      GET: ({ request }) =>
        githubCallback(request, {
          config: githubConfig,
          getCookie,
          deleteCookie,
          exchangeCode: (config, code, callback) => exchangeCode(config, code, callback),
          readProfile,
          signInUser: async (profile) => (await signInGithubUser(database(), profile)).id,
          startSession,
        }),
    },
  },
});
