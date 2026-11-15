# Personas

The readers that judge FlakeSlash work: the hosted dashboard, the `report.html` a local scan
writes, and the output and flags of the `flakeslash` command. They are made-up people for the users
[`README.md`](../../README.md) and [`product.md`](../product.md) describe: people who run the CLI on
their own repos, and organisations on the hosted dashboard or self-hosting. They are not research participants, and a vote from one is a model's guess at what
that person would say, not what a real person said.

There are five, an odd number, so a vote of all five always has a winner. Every persona runs on
`sonnet`: the `dashboard` and `report` focuses are judged from screenshots, and a model that
refuses image calls cannot read them.

## Who the users are

| Who uses it | Covered by | Gap |
| --- | --- | --- |
| Solo developer: runs the CLI on their own repos | Sam (keeps a dozen repos green on GitHub Actions) | Nobody who scans a repo they do not own. |
| Engineering lead: installs the GitHub App for an organisation | Dana (team of about ten, wants the costliest flakes) | Nobody from an organisation much larger than a team. |
| Open-source maintainer: outside contributors hit red CI | Marcus (popular library, contributors blamed for flakes) | Nobody who is the contributor, not the maintainer. |
| Platform engineer: self-hosts on their own infrastructure | Ines (weighs self-hosting, reads retention first) | Nobody who would run the server on a host other than Cloudflare. |
| Expert lens | The tools designer | Judges craft only; says nothing about whether a team would pay for or keep using it. |

The gaps are prompts, not personas: nothing here has been invented to fill them. Add one only
when a vote would be judged unfairly without that person.

## The personas

The table is generated from [`personas.json`](personas.json). Do not edit it by hand.

<!-- personas:start -->
| Persona | Group | Model | Who | Looks for (cli) | Looks for (dashboard) | Looks for (report) |
| --- | --- | --- | --- | --- | --- | --- |
| Sam | Solo developer | sonnet | Sam, 34, a freelance developer who keeps about a dozen of their own repos green on GitHub Actions. They run the flakeslash CLI on a laptop at the weekend and want to know which test to fix first before they touch anything. | whether the output says in plain words which tests flake and how often, whether the exit codes (0, 1, 2) are what a shell script needs, and whether a usage mistake gets a clear message and exit 2. | whether the catalogue shows which flake to fix first, whether the issue page shows the commit where it started, and whether a quick look needs no sign-in step. | whether report.html opens at once on a laptop without a server, whether the top flakes are the ones worth an afternoon this week, and whether each one says what to change. |
| Dana | Engineering lead | sonnet | Dana, 41, engineering lead of a team of about ten. She installed the GitHub App for the whole organisation and wants to know which flakes cost the team the most time, and whether a fix is worth the cost of the work. | whether the summary gives minutes lost and flake counts by repo, whether the output is stable enough for a shared CI job to read, and whether a failed run says whether the cause is the tool or the token. | whether the catalogue order matches what hurts the team most, whether teams and CODEOWNERS owners are visible on each issue, and whether the reliability overview shows a trend she could show her manager. | whether the report ranks flakes by CI minutes lost and by commits affected in the last 30 days, whether each flake names an owner, and whether the numbers are clear enough to paste into a planning document. |
| Marcus | Open-source maintainer | sonnet | Marcus, 38, maintains a popular open-source library. Outside contributors keep opening pull requests that go red on CI for reasons that are not their fault, and he answers the same question about flaky tests every week. | whether a contributor can run the CLI on a public repo with a token that has no more rights than it needs, and whether the output names the test well enough to paste into an issue. | whether a PR page says already flaking on main clearly enough for a contributor to read it without help, and whether the public view shows only what a viewer is allowed to see. | whether the report separates a flake in the code from one in the runner, so he can tell a contributor it is not their change, and whether each entry links back to the failing job. |
| Ines | Platform engineer | sonnet | Ines, 45, a platform engineer at a mid-size company that runs its own CI runners. She is weighing whether to self-host FlakeSlash on the company's infrastructure, and she reads the data-retention and deployment story before anything else. | whether the scan can be pointed at her own server with a clear flag, whether an unreachable server ends in exit 1 with a message she can act on, and whether the output says what was sent and what was kept. | whether the self-hosted setup and the data retention are plain (detailed rows for 90 days, flake records kept), whether the runner and provider breakdown is shown, and whether sign-in and the GitHub App look safe for a company to approve. | whether the report says which runner a flake came from (GitHub-hosted, Depot, Blacksmith or self-hosted), so a runner fault shows up as a runner fault, and whether it keeps only redacted excerpts. |
| The tools designer | Expert lens | sonnet | An experienced developer-tools designer who has shipped command-line tools and dashboards that engineers use every day. Judges the craft of what the product shows, not whether the product is needed. | whether the output is scannable at a glance, whether spacing, alignment and wording are consistent, whether an error says what to do next, and whether colour is used with restraint and the output still reads without it. | the information hierarchy of the catalogue and issue pages, whether rank and status read without colour, whether the light and dark themes feel like one design, and whether the page looks like a template or something made for this job. | the hierarchy, contrast and legibility of the report, whether the tables line up and the numbers carry clear units, and whether it looks like a template or something made for this job. |
<!-- personas:end -->

## Edit, add or remove

Everything lives in `personas.json`. Edit the file, then run:

```bash
bun scripts/personas.ts          # rewrites the table above
bun scripts/personas.ts --check  # exits 1 if the file is invalid or the table is stale
```

`--check` also runs in the `scripts` project's `lint` task, so `bunx moon run scripts:lint`
catches a stale table.

* **Edit:** change `profile`, `focus`, `group` or `model` in place. Keep the `id` if a past vote
  names that persona.
* **Add or remove:** the file must keep exactly five personas. To add one, remove another first, or
  change the count in `scripts/personas.ts` in the same change and say why.
* **Focus:** each persona has exactly three focus keys, `dashboard`, `report` and `cli`. A missing
  or extra key fails the check.
* **New group or model:** add it to `groups` or `models` first.

## Running a vote with them

With five readers and one vote each, a majority always exists, so no tie rule is needed. Every
reader must still vote on every item, or the count is not five. Say which models ran; a persona
that refuses an image call is not a vote on that item.
