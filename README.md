# OpenCode ticket-to-PR pipeline

A small OpenCode template that takes a Jira ticket and ends with a reviewed pull request on GitHub or Bitbucket, plus the ticket moved to review.

```
/ticket CHAT-42

orchestrator (primary)                          subagents
  1 preflight: clean tree, known remote
  2 jira_get -> ticket brief
  3 branch <type>/<KEY>-<desc> off origin/<base>
  4 ------------------------------------------> planner      (read-only)
  5 ------------------------------------------> implementer  (edits, runs checks)
  6 ------------------------------------------> reviewer     (read-only, runs checks)
      FAIL -> implementer -> reviewer, max 3 rounds
  7 git commit (Conventional Commit, Refs KEY)
  8 git push -u origin <branch>                 [approval]
  9 pr_create (GitHub or Bitbucket)             [approval]
 10 jira_transition -> review, jira_comment PR  [approval]
```

## Layout

```
.opencode/
  agents/orchestrator.md   primary agent: Jira, git, PR; delegates the rest
  agents/planner.md        ticket brief -> plan
  agents/implementer.md    plan -> code + tests, never commits
  agents/reviewer.md       diff vs. plan and acceptance criteria -> PASS / FAIL
  commands/ticket.md       /ticket <KEY>
  tools/pr.ts              pr_create tool (opencode wrapper)
  lib/pr-core.mts          GitHub + Bitbucket REST client (no gh CLI needed)
  opencode.jsonc           pr_write: ask
tests/pr-core.test.ts      unit tests for the PR client
```

The Jira tools (`jira_get`, `jira_transition`, `jira_comment`, ...) live in the global config at `~/.config/opencode/tools/jira.ts`.

## Design choices

- The orchestrator handles the few deterministic steps itself (Jira, branch, commit, push, PR), so only planning, implementing and reviewing are separate agents.
- Every agent has a minimal permission set; for bash the last matching rule wins, so narrow denies come last.
- Subagents receive only what they need (brief, plan, findings, base commit), never the conversation history.
- The review loop passes only the latest round's findings back to the implementer.
- The branch is created from `origin/<base>` and the base commit is recorded, so the reviewer diffs exactly the change.
- Everything that leaves the machine (push, PR, Jira writes) asks for approval.
- The project-specific parts (base branch, check commands, Jira status) live in each project's `AGENTS.md`, so the same agents work for uv, Poetry and npm projects.

## Setup

1. Load the template in any project by pointing OpenCode at it, e.g. in `~/.bashrc`:

   ```bash
   export OPENCODE_CONFIG_DIR="$HOME/projects/PROGRAMMING_WORKFLOW/.opencode"
   ```

   It is merged with the global config (`~/.config/opencode`) and the project's own `.opencode/`.

2. Credentials, exported in the shell that starts OpenCode:

   | Variable | For |
   | --- | --- |
   | `JIRA_EMAIL`, `JIRA_API_TOKEN` | Jira tools |
   | `GITHUB_TOKEN` (or `GH_TOKEN`) | GitHub PRs - fine-grained token, "Pull requests: read and write" |
   | `BITBUCKET_EMAIL`, `BITBUCKET_API_TOKEN` | Bitbucket PRs - Atlassian API token with `read:pullrequest:bitbucket` and `write:pullrequest:bitbucket` |

3. Add a `## Pipeline` section to the project's `AGENTS.md`:

   ```markdown
   ## Pipeline
   - Base branch: main
   - Checks: `uv run pytest`, `uv run ruff check .`
   - Jira review status: In Review
   ```

   If it is missing, the orchestrator asks once instead of guessing.

## Usage

Start OpenCode in the project, switch to the `orchestrator` agent or simply run:

```
/ticket CHAT-42
```

The working tree must be clean.
If review still fails after 3 rounds, the pipeline stops and leaves the branch for you.

## Development

```bash
node --test "tests/*.test.ts"
opencode debug agent orchestrator   # show resolved tools and permissions
```
