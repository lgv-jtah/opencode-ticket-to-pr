# OpenCode ticket-to-PR pipeline

A small OpenCode template that takes a Jira ticket and ends with a reviewed pull request on GitHub, Bitbucket or GitLab (merge request), plus the ticket moved to review.

```
/ticket CHAT-42

orchestrator (primary)                          subagents
  1 preflight: clean tree, known remote, detach at origin/<base>
  2 jira_get -> ticket brief
  3 ------------------------------------------> planner      (read-only)
      readiness check: BLOCKED -> your answers
      assumptions -> you confirm or correct
  4 branch <type>/<KEY>-<desc> at origin/<base>
  5 ------------------------------------------> implementer  (edits, runs checks)
  6 ------------------------------------------> reviewer     (read-only, runs checks)
      FAIL -> implementer -> reviewer, max 3 rounds
  7 git commit (Conventional Commit, Refs KEY)
  8 side findings -> you pick -> Bug tickets    [approval]
  9 git push -u origin <branch>                 [approval]
 10 pr_create (GitHub, Bitbucket or GitLab)     [approval]
 11 jira_transition -> review, jira_comment PR  [approval]
```

## Layout

```
.opencode/
  AGENTS.md                global rules (pipeline, git, Jira) for every project
  agents/orchestrator.md   primary agent: Jira, git, PR; delegates the rest
  agents/planner.md        ticket brief -> plan
  agents/implementer.md    plan -> code + tests, never commits
  agents/reviewer.md       diff vs. plan and acceptance criteria -> PASS / FAIL
  commands/ticket.md       /ticket <KEY>
  commands/jira-tickets.md /jira-tickets <plan-file> - create epic + tickets from a plan
  tools/jira.ts            jira_get, jira_search, jira_create, jira_link, jira_transition, ...
  lib/jira-core.ts         Jira REST client, Markdown <-> Jira document format
  tools/pr.ts              pr_create tool (opencode wrapper)
  lib/pr-core.mts          GitHub + Bitbucket + GitLab REST client (no gh / glab CLI needed)
  opencode.jsonc           jira_write: ask, pr_write: ask
tests/pr-core.test.ts      unit tests for the PR client
scripts/                   logic behind the Makefile targets
Makefile                   entry point: make install / doctor / init / ticket
```

The template is self-contained: cloning the repo and running `make install` gives the full setup on a new machine.

> **Note:** while `OPENCODE_CONFIG_DIR` is set, opencode loads `.opencode/AGENTS.md` from this template instead of `~/.config/opencode/AGENTS.md`.
> Keep all global rules in the template's `AGENTS.md`; `make doctor` warns if a global one is left over.

## Design choices

- The orchestrator handles the few deterministic steps itself (Jira, branch, commit, push, PR), so only planning, implementing and reviewing are separate agents.
- Every agent has a minimal permission set; for bash the last matching rule wins, so narrow denies come last.
- Subagents receive only what they need (brief, plan, findings, base commit), never the conversation history.
- The review loop passes only the latest round's findings back to the implementer.
- The planner checks the ticket against the code before planning: it blocks only when a wrong guess would be expensive, otherwise it decides and lists the decision as an assumption for you to confirm.
- The branch is only created once the plan is accepted, at `origin/<base>`, and the base commit is recorded, so the reviewer diffs exactly the change.
- Bugs found outside the ticket's scope are never fixed in the branch: planner, implementer and reviewer report them as side findings, you pick which become Bug tickets (deduplicated via search, labelled `pipeline-finding`, linked to the ticket as "Relates"), and the PR lists them.
- Everything that leaves the machine (push, PR, Jira writes) asks for approval.
- The project-specific parts (base branch, check commands, Jira status) live in each project's `AGENTS.md`, so the same agents work for uv, Poetry and npm projects.

## Quick start

```bash
make install && source ~/.bashrc                         # load the template in every project
make doctor                                              # check opencode, credentials, template
make init PROJECT=~/projects/my-repo                     # add the Pipeline section to its AGENTS.md
make ticket PROJECT=~/projects/my-repo TICKET=CHAT-42    # run the pipeline
```

Run `make` to list all targets.

### Only for one project

To use the pipeline in a single project without any global setup, copy it into the project:

```bash
make vendor PROJECT=~/projects/my-repo    # writes my-repo/.opencode/ and the Pipeline section
```

Commit the project's `.opencode/` and `AGENTS.md`.
From then on, plain `opencode` in that project has `/ticket` and `/jira-tickets`, for everyone who clones it.
Teammates only need opencode and the credentials below, not this template.

- The template's global rules are copied to `.opencode/pipeline-rules.md` and loaded via `instructions` in `.opencode/opencode.jsonc`.
- `.opencode/pipeline.manifest` records the template version and a checksum per file.
- Re-run `make vendor` to update: unchanged files are replaced, files dropped from the template are removed.
- If a vendored file was edited in the project, or a file with the same name already existed, nothing is written and the conflicts are listed; `FORCE=1` overwrites them, `DRY_RUN=1` only previews.
- Keep project-specific instructions in the project's `AGENTS.md`, not in the vendored files.
- If the project already has its own `.opencode/opencode.jsonc`, that is reported as a conflict too; move its settings to `.opencode/opencode.json` or a root `opencode.json`, which opencode merges with it.

| Target | What it does |
| --- | --- |
| `install` / `uninstall` | Adds or removes `export OPENCODE_CONFIG_DIR=<this template>` in `~/.bashrc` (`~/.zshrc` for zsh; `RC_FILE=...` to override). OpenCode merges it with the global config and the project's own `.opencode/`. |
| `doctor` | Checks opencode, git, that the orchestrator loads with all its tools, leftover global config, and which credentials are set (never prints values). |
| `vendor PROJECT=...` | Copies the pipeline into the project's own `.opencode/` and runs `init`, so it works without `install` (see [Only for one project](#only-for-one-project)). Re-run to update; `DRY_RUN=1` previews, `FORCE=1` overwrites local edits. |
| `init PROJECT=...` | Detects base branch and check commands (uv, Poetry, npm) and appends a `## Pipeline` section to the project's `AGENTS.md`. Never overwrites an existing section; `DRY_RUN=1` previews, `JIRA_REVIEW_STATUS=...` sets the Jira status. |
| `ticket PROJECT=... TICKET=...` | Opens the OpenCode TUI in the project with the orchestrator running the ticket. Works without `install`. |
| `test` | Runs the unit tests of the PR client. |

### Credentials

Export them in the shell that starts OpenCode:

| Variable | For |
| --- | --- |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | Jira tools |
| `JIRA_BASE_URL` (optional) | Jira instance, e.g. `https://your-org.atlassian.net`; defaults to the URL in `lib/jira-core.ts` |
| `GITHUB_TOKEN` (or `GH_TOKEN`) | GitHub PRs - fine-grained token, "Pull requests: read and write" |
| `BITBUCKET_EMAIL`, `BITBUCKET_API_TOKEN` | Bitbucket PRs - Atlassian API token with `read:pullrequest:bitbucket` and `write:pullrequest:bitbucket` |
| `GITLAB_TOKEN` | GitLab merge requests - personal, group or project access token with the `api` scope (Developer role or higher) |
| `GITLAB_URL` (optional) | Self-hosted GitLab, e.g. `https://gitlab.example.com`; remotes on its hostname are treated as GitLab. `gitlab.com` always works without it |

### Project settings

`make init` writes a section like this, which you can adjust by hand:

```markdown
## Pipeline
- Base branch: main
- Checks: `uv run pytest`, `uv run ruff check .`
- Jira review status: In Review
```

If it is missing, the orchestrator asks once instead of guessing.

## Usage

`make ticket ...`, or inside OpenCode in any project:

```
/ticket CHAT-42
```

The working tree must be clean.
If review still fails after 3 rounds, the pipeline stops and leaves the branch for you.

## Development

```bash
make test
opencode debug agent orchestrator   # show resolved tools and permissions
```
