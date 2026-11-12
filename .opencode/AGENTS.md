# Global agent rules

These rules are loaded in every project while `OPENCODE_CONFIG_DIR` points to
this template. They replace `~/.config/opencode/AGENTS.md`, which opencode
does not load in that case - keep all global rules here.

## Pipeline discipline
- When acting as part of the ticket-to-PR pipeline (`/ticket`: orchestrator,
  planner, implementer, reviewer), stay strictly inside your role's scope.
  Don't do another agent's job even if it seems faster.
- Required sentinel tokens (PLANNING DONE / PLANNING BLOCKED, IMPLEMENTATION DONE,
  REVIEW PASS / REVIEW FAIL) must appear on their own, exactly as specified, as
  the last line of your final message. Do not wrap them in markdown formatting
  (no **bold**, no backticks).
- Bugs outside the ticket's scope go into a `## Side findings` section (with
  evidence), never into the current branch.

## Git convention (all projects)
- Branch naming: `<type>/<ticket-key>-<short-kebab-description>`, where type is
  one of feature, bugfix, chore, hotfix.
- Commit messages: Conventional Commits format - `<type>(<scope>): <summary>`,
  body references the ticket key as `Refs <TICKET-KEY>`.
- Never force-push, never push to the base branch, never rewrite pushed history.
- Pushing a feature branch and opening a PR (`pr_create`) happen only as the
  final step of the `/ticket` pipeline or when the user explicitly asks; both
  always need the user's approval.
- No AI attribution or Co-Authored-By trailers in commits or PRs.

## Jira
- Jira is reached through the `jira_*` tools of this template (`tools/jira.ts`).
  They need `JIRA_EMAIL` and `JIRA_API_TOKEN` (and optionally `JIRA_BASE_URL`)
  in the environment opencode was started from; if they are missing, tell the
  user instead of working around it.
- Only create, update, link, comment on or transition Jira issues when the user
  asks for it, or as part of the `/ticket` pipeline (bug tickets for side
  findings the user selected, linked to the ticket; moving the ticket to review
  and commenting the PR link). Every write asks for approval (`jira_write`);
  never delete.
- For a batch of tickets from a plan, use the `/jira-tickets` command.

## General
- Prefer explaining trade-offs over silently picking one when a decision is
  non-obvious or expensive to reverse.
