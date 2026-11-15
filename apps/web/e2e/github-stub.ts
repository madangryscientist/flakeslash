/**
 * A stand-in for github.com and api.github.com, enough for the GitHub App's user authorization:
 * authorize bounces straight back with a code, the code (or the refresh token) buys a token that
 * expires as an App user token does, and the token reads one fixed user. Every value here is a
 * fixed test value that the e2e build (`vite.config.ts`) is configured with; none is real.
 */
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";

const STUB_USER = { id: 4242, login: "e2e-octocat", name: "E2E Octocat", avatar_url: null };

const STUB_TOKENS = {
  access_token: "stub-token",
  expires_in: 28800,
  refresh_token: "stub-refresh",
  refresh_token_expires_in: 15897600,
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => resolve(raw));
  });
}

async function readJson(req: IncomingMessage): Promise<object> {
  try {
    const body: unknown = JSON.parse(await readBody(req));
    return typeof body === "object" && body !== null ? body : {};
  } catch {
    return {};
  }
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

const json = (res: ServerResponse, body: unknown) =>
  void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));

/** A grant the stub accepts: the authorize code, or the refresh token it handed out. */
function grantAccepted(body: object): boolean {
  if (Reflect.get(body, "client_secret") !== "e2e-secret") return false;
  if (Reflect.get(body, "grant_type") === "refresh_token")
    return Reflect.get(body, "refresh_token") === "stub-refresh";
  return Reflect.get(body, "code") === "stub-code";
}

const ROUTES: Record<string, Handler> = {
  "/health": (_req, res) => void res.end("ok"),
  "/login/oauth/authorize": (_req, res, url) => {
    const back = new URL(url.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", "stub-code");
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: back.toString() }).end();
  },
  // GitHub answers a refused grant with 200 and an `error` field, so the stub does too.
  "/login/oauth/access_token": async (req, res) => {
    json(
      res,
      grantAccepted(await readJson(req)) ? STUB_TOKENS : { error: "bad_verification_code" },
    );
  },
  "/user": (req, res) => {
    if (req.headers.authorization === "Bearer stub-token") json(res, STUB_USER);
    else res.writeHead(401).end();
  },
};

const port = Number(process.env["FLAKESLASH_E2E_STUB_PORT"]);
if (!port) throw new Error("FLAKESLASH_E2E_STUB_PORT must be set");

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = ROUTES[url.pathname];
  if (route) void route(req, res, url);
  else res.writeHead(404).end();
}).listen(port);
