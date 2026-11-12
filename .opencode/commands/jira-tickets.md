---
description: Create a set of Jira tickets (epic, tickets, "blocks" links) from a plan file, with preview and approval
agent: build
---

Create Jira tickets from a ticket plan. Arguments: `$ARGUMENTS`
(first: path to the plan file; second, optional: project key, default `CHAT`).

Use only the `jira_*` tools for Jira. Never delete anything in Jira.

## Plan file format

Markdown or YAML; read it and interpret it. It contains:

- optionally an **epic** (summary and description),
- **tickets**, each with a local id (`T1`, `T2`, ...), type (Story/Task/Bug; "feature" -> Story,
  "chore" -> Task unless the project says otherwise), summary, labels, description
  (scope, "done when", notes) and optionally an existing issue key it maps to,
- **dependencies** as "A blocks B" pairs of local ids.

Example: `/tmp/opencode/chat-tickets.md`.
If the file is missing or something essential is unclear, ask the user before going on.

## Steps

1. **Check access and project.** Call `jira_project_info` for the project. If credentials are
   missing, tell the user exactly what to export (`JIRA_EMAIL`, `JIRA_API_TOKEN`) and stop.
   Map the plan's types to the project's issue types and note required fields.
2. **Find existing tickets.** Use `jira_search` (e.g. `project = KEY ORDER BY created DESC`) and
   compare summaries with the plan. A ticket whose summary matches (case-insensitive, ignoring
   punctuation) is reused, not created again. Also reuse tickets the plan maps explicitly.
3. **Resume progress.** Progress lives in `/tmp/opencode/jira-tickets/<plan file name>.json`
   (`{"project", "epic", "keys": {"T1": "KEY-1", ...}, "links": ["T1>T2", ...]}`). If it exists,
   treat recorded keys as done and verify them with `jira_get` before relying on them.
4. **Preview.** Print a table: local id | action (create / reuse KEY / update KEY) | type |
   summary | labels | parent | blocked by. Below it, list anything you changed from the plan and
   why. Then ask the user for an explicit OK with the `question` tool. Do not write before that.
5. **Create.** In this order, saving progress after every successful call:
   1. the epic (`jira_create`, type Epic) unless reused,
   2. updates of reused tickets the user approved (parent, description, labels via `jira_update`),
   3. each ticket (`jira_create` with `parent` = epic, Markdown description),
   4. the links (`jira_link` with `from` = blocking ticket, `to` = blocked ticket, type `Blocks`).
   On an error: stop, report what was done and what failed, and keep the progress file so a rerun
   continues where it stopped.
6. **Verify.** `jira_search` with `parent = <epic>` and check count, parents and labels; spot-check
   one link with `jira_get`.
7. **Report in the chat only** (do not write files into the project): a table
   local id | key | type | summary | blocked by, plus the epic key and the board/browse URL.
   Remind the user to revoke short-lived API tokens if they created one for this.
