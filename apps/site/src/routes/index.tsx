import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [{ title: "FlakeSlash: flaky-test detection you can self-host" }],
  }),
  component: Home,
});

function Home() {
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">FlakeSlash</h1>
      <p>Open source flaky-test detection you can run yourself. MIT licensed.</p>
      <p>
        FlakeSlash is in early development: the repository is a skeleton and detects nothing yet.
      </p>
    </div>
  );
}
