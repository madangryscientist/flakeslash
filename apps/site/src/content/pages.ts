/** Every page of the site, in nav order. The build prerenders each one; the nav and the smoke test read the same list. */
export const PAGES = [
  { to: "/", label: "Home" },
  { to: "/docs", label: "Docs" },
] as const;
