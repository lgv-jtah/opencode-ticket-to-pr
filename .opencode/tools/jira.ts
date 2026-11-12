/**
 * Jira Cloud tools for opencode.
 *
 * Credentials come from the environment of the opencode process:
 *   JIRA_EMAIL, JIRA_API_TOKEN            (required)
 *   JIRA_BASE_URL                         (optional, default below)
 *
 * Reading tools run without approval. Every write goes through
 * context.ask() with the permission "jira_write" (set to "ask" in
 * opencode.jsonc), so nothing changes in Jira without the user's OK.
 * There is deliberately no delete tool.
 */
import { tool } from "@opencode-ai/plugin"
import { KEY, adfToText, browseUrl, confirm, jira, linkLines, markdownToAdf, type Node } from "../lib/jira-core.ts"

const s = tool.schema

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const get = tool({
  description:
    "Read one Jira issue: summary, type, status, parent, labels, assignee, links and description (as Markdown). Optionally the latest comments.",
  args: {
    key: KEY,
    comments: s.number().int().min(0).max(50).optional().describe("Number of latest comments to include (default 0)"),
  },
  async execute(args, ctx) {
    const f = "summary,issuetype,status,parent,labels,assignee,reporter,priority,created,updated,issuelinks,description,components"
    const i = await jira("GET", `/rest/api/3/issue/${args.key}?fields=${f}`, undefined, ctx.abort)
    const x = i.fields
    const out = [
      `# ${i.key}: ${x.summary}`,
      `${browseUrl(i.key)}`,
      "",
      `- Type: ${x.issuetype?.name}  |  Status: ${x.status?.name}  |  Priority: ${x.priority?.name ?? "-"}`,
      `- Parent: ${x.parent ? `${x.parent.key} (${x.parent.fields?.summary ?? ""})` : "-"}`,
      `- Labels: ${(x.labels ?? []).join(", ") || "-"}  |  Components: ${(x.components ?? []).map((c: Node) => c.name).join(", ") || "-"}`,
      `- Assignee: ${x.assignee?.displayName ?? "-"}  |  Reporter: ${x.reporter?.displayName ?? "-"}`,
      `- Created: ${x.created?.slice(0, 16)}  |  Updated: ${x.updated?.slice(0, 16)}`,
      "",
      "## Links",
      ...(linkLines(x.issuelinks).length ? linkLines(x.issuelinks) : ["- none"]),
      "",
      "## Description",
      adfToText(x.description) || "(none)",
    ]
    if (args.comments) {
      const c = await jira(
        "GET",
        `/rest/api/3/issue/${args.key}/comment?orderBy=-created&maxResults=${args.comments}`,
        undefined,
        ctx.abort,
      )
      out.push("", "## Comments (latest first)")
      for (const cm of c.comments ?? []) out.push(`### ${cm.author?.displayName}, ${cm.created?.slice(0, 16)}`, adfToText(cm.body), "")
      if (!(c.comments ?? []).length) out.push("- none")
    }
    return out.join("\n")
  },
})

export const search = tool({
  description:
    "Search Jira issues with JQL. Returns one line per issue: key, type, status, summary, parent, labels. Example JQL: 'project = CHAT AND parent = CHAT-4 ORDER BY key'.",
  args: {
    jql: s.string().min(1).describe("JQL query"),
    maxResults: s.number().int().min(1).max(100).optional().describe("Max issues (default 50)"),
  },
  async execute(args, ctx) {
    const q = new URLSearchParams({
      jql: args.jql,
      maxResults: String(args.maxResults ?? 50),
      fields: "summary,issuetype,status,parent,labels",
    })
    const r = await jira("GET", `/rest/api/3/search/jql?${q}`, undefined, ctx.abort)
    const issues = r.issues ?? []
    if (!issues.length) return "No issues found."
    const lines = issues.map((i: Node) => {
      const f = i.fields
      return `${i.key} | ${f.issuetype?.name} | ${f.status?.name} | ${f.summary} | parent: ${f.parent?.key ?? "-"} | labels: ${(f.labels ?? []).join(",") || "-"}`
    })
    if (r.isLast === false || r.nextPageToken) lines.push(`(more results exist - narrow the JQL or raise maxResults)`)
    return lines.join("\n")
  },
})

export const project_info = tool({
  description:
    "Describe a Jira project before creating issues: issue types (with hierarchy level), non-standard required fields per type, available link types and priorities.",
  args: { project: s.string().regex(/^[A-Z][A-Z0-9_]+$/).describe("Project key, e.g. CHAT") },
  async execute(args, ctx) {
    const p = await jira("GET", `/rest/api/3/project/${args.project}`, undefined, ctx.abort)
    const out = [`# ${p.key}: ${p.name} (${p.style ?? ""} ${p.projectTypeKey ?? ""})`, "", "## Issue types"]
    const standard = new Set(["project", "issuetype", "summary", "reporter"])
    for (const t of p.issueTypes ?? []) {
      let req: string[] = []
      try {
        const m = await jira("GET", `/rest/api/3/issue/createmeta/${p.key}/issuetypes/${t.id}?maxResults=200`, undefined, ctx.abort)
        const fields = m.fields ?? m.values ?? []
        req = fields.filter((f: Node) => f.required && !standard.has(f.fieldId)).map((f: Node) => `${f.name} (${f.fieldId})`)
        if (fields.some((f: Node) => f.fieldId === "parent")) req.push("[parent supported]")
      } catch (e) {
        req = [`(create metadata unavailable: ${(e as Error).message})`]
      }
      out.push(`- ${t.name} (id ${t.id}, level ${t.hierarchyLevel})${req.length ? ": " + req.join(", ") : ""}`)
    }
    const lt = await jira("GET", `/rest/api/3/issueLinkType`, undefined, ctx.abort)
    out.push("", "## Link types (use the name; 'from <outward> to')")
    for (const l of lt.issueLinkTypes ?? []) out.push(`- ${l.name}: "${l.outward}" / "${l.inward}"`)
    try {
      const pr = await jira("GET", `/rest/api/3/priority`, undefined, ctx.abort)
      out.push("", "## Priorities", (pr ?? []).map((x: Node) => x.name).join(", "))
    } catch {}
    return out.join("\n")
  },
})

export const create = tool({
  description:
    "Create a Jira issue (asks the user for approval). Description is Markdown and is converted to Jira's format. Use 'parent' for the epic of a story/task.",
  args: {
    project: s.string().regex(/^[A-Z][A-Z0-9_]+$/).describe("Project key, e.g. CHAT"),
    type: s.string().min(1).describe("Issue type name, e.g. Epic, Story, Task, Bug"),
    summary: s.string().min(1).max(255),
    description: s.string().optional().describe("Markdown description"),
    labels: s.array(s.string().regex(/^\S+$/, "Labels cannot contain spaces")).optional(),
    parent: KEY.optional().describe("Parent issue key (e.g. the epic)"),
    priority: s.string().optional().describe("Priority name, e.g. Medium"),
  },
  async execute(args, ctx) {
    await confirm(ctx, "create", args.project, {
      type: args.type,
      summary: args.summary,
      parent: args.parent,
      labels: args.labels,
    })
    const fields: Node = {
      project: { key: args.project },
      issuetype: { name: args.type },
      summary: args.summary,
    }
    if (args.description) fields.description = markdownToAdf(args.description)
    if (args.labels?.length) fields.labels = args.labels
    if (args.parent) fields.parent = { key: args.parent }
    if (args.priority) fields.priority = { name: args.priority }
    const r = await jira("POST", "/rest/api/3/issue", { fields }, ctx.abort)
    ctx.metadata({ title: `Created ${r.key}` })
    return `Created ${r.key} (${args.type}): ${args.summary}\n${browseUrl(r.key)}`
  },
})

export const update = tool({
  description:
    "Update fields of a Jira issue (asks the user for approval). Only the given fields change. 'labels' replaces all labels; 'addLabels'/'removeLabels' change them incrementally. Description is Markdown.",
  args: {
    key: KEY,
    summary: s.string().min(1).max(255).optional(),
    description: s.string().optional().describe("New Markdown description (replaces the old one)"),
    labels: s.array(s.string().regex(/^\S+$/)).optional(),
    addLabels: s.array(s.string().regex(/^\S+$/)).optional(),
    removeLabels: s.array(s.string().regex(/^\S+$/)).optional(),
    parent: KEY.optional(),
    priority: s.string().optional(),
  },
  async execute(args, ctx) {
    const fields: Node = {}
    const update: Node = {}
    if (args.summary) fields.summary = args.summary
    if (args.description !== undefined) fields.description = markdownToAdf(args.description)
    if (args.labels) fields.labels = args.labels
    if (args.parent) fields.parent = { key: args.parent }
    if (args.priority) fields.priority = { name: args.priority }
    const ops = [...(args.addLabels ?? []).map((l) => ({ add: l })), ...(args.removeLabels ?? []).map((l) => ({ remove: l }))]
    if (ops.length) {
      if (args.labels) throw new Error("Use either 'labels' or 'addLabels'/'removeLabels', not both.")
      update.labels = ops
    }
    const changed = [...Object.keys(fields), ...Object.keys(update)]
    if (!changed.length) return "Nothing to update."
    await confirm(ctx, "update", args.key, { fields: changed })
    await jira("PUT", `/rest/api/3/issue/${args.key}`, { fields, update }, ctx.abort)
    return `Updated ${args.key}: ${changed.join(", ")}\n${browseUrl(args.key)}`
  },
})

export const link = tool({
  description:
    "Link two Jira issues (asks the user for approval). Reads as 'from <outward verb> to': type 'Blocks' with from=CHAT-3, to=CHAT-5 means 'CHAT-3 blocks CHAT-5'. Skips links that already exist.",
  args: {
    from: KEY.describe("Issue on the outward side, e.g. the blocking issue"),
    to: KEY.describe("Issue on the inward side, e.g. the blocked issue"),
    type: s.string().optional().describe("Link type name (default 'Blocks'); see jira_project_info"),
  },
  async execute(args, ctx) {
    const typeName = args.type ?? "Blocks"
    const types = (await jira("GET", "/rest/api/3/issueLinkType", undefined, ctx.abort)).issueLinkTypes ?? []
    const lt = types.find((t: Node) => t.name.toLowerCase() === typeName.toLowerCase())
    if (!lt) throw new Error(`Unknown link type '${typeName}'. Available: ${types.map((t: Node) => t.name).join(", ")}`)
    const existing = (await jira("GET", `/rest/api/3/issue/${args.from}?fields=issuelinks`, undefined, ctx.abort)).fields
      ?.issuelinks ?? []
    if (existing.some((l: Node) => l.type?.name === lt.name && l.outwardIssue?.key === args.to)) {
      return `Already linked: ${args.from} ${lt.outward} ${args.to}`
    }
    await confirm(ctx, "link", `${args.from} ${lt.outward} ${args.to}`, { type: lt.name })
    // Jira's REST naming is counterintuitive: the issue in "inwardIssue" ends up
    // with the OUTWARD description ("blocks"). Verified against Jira Cloud on
    // 2 Nov 2026: inwardIssue=A, outwardIssue=B  =>  "A blocks B".
    await jira(
      "POST",
      "/rest/api/3/issueLink",
      { type: { name: lt.name }, inwardIssue: { key: args.from }, outwardIssue: { key: args.to } },
      ctx.abort,
    )
    return `Linked: ${args.from} ${lt.outward} ${args.to}`
  },
})

export const comment = tool({
  description: "Add a comment to a Jira issue (asks the user for approval). Body is Markdown.",
  args: { key: KEY, body: s.string().min(1).describe("Markdown comment") },
  async execute(args, ctx) {
    await confirm(ctx, "comment", args.key, { preview: args.body.slice(0, 200) })
    const r = await jira("POST", `/rest/api/3/issue/${args.key}/comment`, { body: markdownToAdf(args.body) }, ctx.abort)
    return `Comment ${r.id} added to ${args.key}\n${browseUrl(args.key)}`
  },
})

export const transition = tool({
  description:
    "Move a Jira issue to another status (asks the user for approval). 'to' matches a transition name or target status name, case-insensitive. Lists the allowed transitions if nothing matches.",
  args: { key: KEY, to: s.string().min(1).describe("Target status or transition name, e.g. 'In Progress'") },
  async execute(args, ctx) {
    const ts = (await jira("GET", `/rest/api/3/issue/${args.key}/transitions`, undefined, ctx.abort)).transitions ?? []
    const want = args.to.toLowerCase()
    const t = ts.find((x: Node) => x.name.toLowerCase() === want || x.to?.name?.toLowerCase() === want)
    if (!t) {
      return `No transition to '${args.to}' from the current status of ${args.key}. Available: ${
        ts.map((x: Node) => `${x.name} -> ${x.to?.name}`).join("; ") || "none"
      }`
    }
    await confirm(ctx, "transition", args.key, { to: t.to?.name })
    await jira("POST", `/rest/api/3/issue/${args.key}/transitions`, { transition: { id: t.id } }, ctx.abort)
    return `${args.key} moved to '${t.to?.name}'`
  },
})
