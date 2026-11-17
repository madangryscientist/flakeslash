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

// The two home-page hrefs the app makes navigate inside the app. Each Link is active only on the
// exact page and query it names, so "Hide dismissed" is not marked as the current page. Every other
// href (the auth routes, which are server endpoints the router does not serve) stays a plain link.
function AppLink(props: LinkAdapterProps) {
  if (props.href === "/?dismissed=1") {
    return <Link to="/" search={{ dismissed: 1 }} activeOptions={{ exact: true }} {...props} />;
  }
  if (props.href === "/") {
    return <Link to="/" search={{}} activeOptions={{ exact: true }} {...props} />;
  }
  return <a {...props} />;
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
