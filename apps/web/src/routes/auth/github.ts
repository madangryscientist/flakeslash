import { createFileRoute } from "@tanstack/react-router";
import { setCookie } from "@tanstack/react-start/server";
import { githubStart } from "#/auth/sign-in-github.ts";
import { githubConfig } from "#/server/env.ts";

export const Route = createFileRoute("/auth/github")({
  server: {
    handlers: {
      GET: ({ request }) => githubStart(request, { config: githubConfig, setCookie }),
    },
  },
});
