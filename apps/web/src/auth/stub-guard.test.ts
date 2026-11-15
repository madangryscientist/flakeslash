import { expect, test } from "vitest";
import { buildKind, githubStubRefusal } from "./stub-guard.ts";

const GITHUB = {
  GITHUB_OAUTH_BASE: "https://github.com",
  GITHUB_API_BASE: "https://api.github.com",
};
const STUB = {
  GITHUB_OAUTH_BASE: "http://localhost:4321",
  GITHUB_API_BASE: "http://localhost:4321",
};

test("a production build pointed at the stand-in is refused", () => {
  expect(githubStubRefusal("production", STUB)).toMatch(/refusing to start/);
});

test("a production build with only one base off GitHub is refused", () => {
  expect(
    githubStubRefusal("production", { ...GITHUB, GITHUB_API_BASE: STUB.GITHUB_API_BASE }),
  ).toMatch(/GITHUB_API_BASE is http:\/\/localhost:4321/);
});

test("a production build on GitHub's own bases starts", () => {
  expect(githubStubRefusal("production", GITHUB)).toBeNull();
});

test("the test build may point at the stand-in", () => {
  expect(githubStubRefusal("test", STUB)).toBeNull();
});

test("with no build kind defined (as under vitest) the build is production", () => {
  expect(buildKind()).toBe("production");
});
