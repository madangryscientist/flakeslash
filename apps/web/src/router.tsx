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

// The home page's links navigate inside the app: the router's Link takes the page and its
// `dismissed` query, and is active only on the exact page and query it names, so "Hide dismissed"
// is not marked as the current page. Any other in-app href (the auth routes are server endpoints
// the router does not serve) stays a plain link.
function AppLink(props: LinkAdapterProps) {
  const url = new URL(props.href, "http://flakeslash.local");
  if (url.pathname !== "/") return <a {...props} />;
  const search: { dismissed?: 1 } =
    url.searchParams.get("dismissed") === "1" ? { dismissed: 1 } : {};
  return (
    <Link to="/" search={search} activeOptions={{ exact: true, includeSearch: true }} {...props} />
  );
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
