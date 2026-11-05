import {
  AppShell,
  AppShellBrand,
  Caption,
  Cluster,
  Stack,
  Tabs,
  TextLink,
} from "@hackcove/ui-react";
import type { ReactNode } from "react";
import { REPO_URL } from "#/content/links";
import { PAGES } from "#/content/pages";

function Footer(): ReactNode {
  return (
    <Stack gap="sm" data-testid="footer">
      <Cluster gap="md">
        <span>MIT licence</span>
        <TextLink href={REPO_URL} external data-testid="source-link">
          GitHub
        </TextLink>
      </Cluster>
      <Caption>FlakeSlash is in early development.</Caption>
    </Stack>
  );
}

/** The frame every page sits in: the brand, the nav row, the page, the footer. */
export function Shell({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}): ReactNode {
  const items = PAGES.map((page) => ({
    label: page.label,
    href: page.to,
    active: page.to === pathname,
  }));
  return (
    <AppShell
      brand={<AppShellBrand href="/" label="FlakeSlash" />}
      subnav={<Tabs variant="pill" items={items} label="Site" size="sm" data-testid="site-nav" />}
      footer={<Footer />}
    >
      {children}
    </AppShell>
  );
}
