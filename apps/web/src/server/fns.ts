import { createServerFn } from "@tanstack/react-start";
import { viewer } from "./session.ts";

/** What a page may know of the signed-in person: their login, never their tokens. */
export const getSignedIn = createServerFn({ method: "GET" }).handler(async () => {
  const signedIn = await viewer();
  return signedIn ? { login: signedIn.user.login } : null;
});
