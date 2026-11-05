import { appShellRootClassFor, colourSchemeScript } from "@hackcove/ui-react";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Shell } from "#/components/shell";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
      { title: "FlakeSlash: flaky-test detection you can self-host" },
      {
        name: "description",
        content: "FlakeSlash is an open source flaky-test detection tool. MIT, self-hostable.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
    // Before first paint: the system's light or dark, so a dark-mode visitor sees no light flash. No cookie.
    scripts: [{ children: colourSchemeScript }],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
});

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <Shell pathname={pathname}>
      <Outlet />
    </Shell>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    // The class differs from the server's markup when the script picked the dark scheme.
    <html lang="en" className={appShellRootClassFor("light")} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
