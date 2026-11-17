import { ErrorPage, type LinkAdapterProps, LinkProvider, NotFound } from "@hackcove/ui-react";
import {
  Link,
  createRouter as createTanStackRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { routeTree } from "./routeTree.gen";

function RouteError({ reset }: ErrorComponentProps) {
  return <ErrorPage onRetry={reset} />;
}

// An in-app link navigates inside the app. The auth routes are server endpoints the router does not
// serve, so they stay plain links and load from the server. `to="."` satisfies the typed `to`; the
// `href` the library passes wins.
function AppLink(props: LinkAdapterProps) {
  if (props.href.startsWith("/auth/")) return <a {...props} />;
  return <Link to="." {...props} />;
}

function InnerWrap({ children }: { children: ReactNode }) {
  return <LinkProvider link={AppLink}>{children}</LinkProvider>;
}

export function getRouter() {
  return createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    InnerWrap,
    defaultNotFoundComponent: () => <NotFound />,
    defaultErrorComponent: RouteError,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
