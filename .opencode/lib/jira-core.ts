/**
 * Shared helpers for tools/jira.ts: HTTP client, approval helper and the
 * Markdown <-> Atlassian Document Format (ADF) conversion.
 * Lives outside tools/ because every export in tools/ becomes a tool.
 */
import { tool, type ToolContext } from "@opencode-ai/plugin"

const DEFAULT_BASE_URL = "https://lgv-hamburg.atlassian.net"

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export function credentials() {
  const email = process.env.JIRA_EMAIL
  const token = process.env.JIRA_API_TOKEN
  if (!email || !token) {
    throw new Error(
      "Jira credentials missing: set JIRA_EMAIL and JIRA_API_TOKEN in the shell " +
        "(e.g. `read -s JIRA_API_TOKEN && export JIRA_API_TOKEN`) and restart opencode from it.",
    )
  }
  const base = (process.env.JIRA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "")
  return { base, token, auth: "Basic " + Buffer.from(`${email}:${token}`).toString("base64") }
}

export async function jira(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const { base, token, auth } = credentials()
  const res = await fetch(base + path, {
    method,
    signal,
    headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await res.text()
  if (!res.ok) {
    let detail = raw.slice(0, 800)
    try {
      const j = JSON.parse(raw)
      const msgs = [...(j.errorMessages ?? []), ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`)]
      if (msgs.length) detail = msgs.join("; ")
    } catch {}
    detail = detail.split(token).join("***")
    throw new Error(`Jira ${method} ${path} failed: HTTP ${res.status} - ${detail}`)
  }
  return raw ? JSON.parse(raw) : {}
}

export function browseUrl(key: string) {
  return `${(process.env.JIRA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "")}/browse/${key}`
}

export async function confirm(ctx: ToolContext, op: string, target: string, metadata: Record<string, unknown>) {
  await ctx.ask({
    permission: "jira_write",
    patterns: [`${op} ${target}`],
    always: [`${op} *`],
    metadata: { operation: op, target, ...metadata },
  })
}

// ---------------------------------------------------------------------------
// Markdown -> Atlassian Document Format (ADF)
// Supported: headings, paragraphs, bullet/ordered lists (nested by indent),
// fenced code blocks, blockquotes, horizontal rules, **bold**, *italic*,
// `code`, [links](url).
// ---------------------------------------------------------------------------

export type Node = Record<string, any>

function inline(text: string): Node[] {
  const out: Node[] = []
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*([^*\s][^*]*)\*)|(\b_([^_]+)_\b)/g
  let last = 0
  let m: RegExpExecArray | null
  const push = (t: string, marks?: Node[]) => {
    if (t) out.push(marks ? { type: "text", text: t, marks } : { type: "text", text: t })
  }
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index))
    if (m[2] !== undefined) push(m[2], [{ type: "strong" }])
    else if (m[4] !== undefined) push(m[4], [{ type: "code" }])
    else if (m[6] !== undefined) push(m[6], [{ type: "link", attrs: { href: m[7] } }])
    else if (m[9] !== undefined) push(m[9], [{ type: "em" }])
    else if (m[11] !== undefined) push(m[11], [{ type: "em" }])
    last = re.lastIndex
  }
  push(text.slice(last))
  return out
}

const para = (text: string): Node => ({ type: "paragraph", content: inline(text) })
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

export function markdownToAdf(md: string): Node {
  const lines = md.replace(/\r\n/g, "\n").split("\n")
  const content: Node[] = []
  let i = 0
  let buf: string[] = []
  const flush = () => {
    if (buf.length) content.push(para(buf.join(" ").trim()))
    buf = []
  }

  const parseList = (baseIndent: number): Node => {
    const ordered = /^\d/.test(lines[i].trim())
    const list: Node = { type: ordered ? "orderedList" : "bulletList", content: [] }
    while (i < lines.length) {
      const m = LIST_RE.exec(lines[i])
      if (!m) break
      const indent = m[1].replace(/\t/g, "  ").length
      if (indent < baseIndent) break
      if (indent > baseIndent) {
        const lastItem = list.content[list.content.length - 1]
        if (!lastItem) break
        lastItem.content.push(parseList(indent))
        continue
      }
      if (/^\d/.test(m[2]) !== ordered) break
      let raw = m[3]
      i++
      // continuation lines (indented, not a new list item)
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_RE.test(lines[i])) raw += " " + lines[i++].trim()
      list.content.push({ type: "listItem", content: [para(raw)] })
    }
    return list
  }

  while (i < lines.length) {
    const line = lines[i]
    const fence = /^```\s*(\S*)/.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++])
      i++
      const node: Node = { type: "codeBlock", content: code.length ? [{ type: "text", text: code.join("\n") }] : [] }
      if (fence[1]) node.attrs = { language: fence[1] }
      content.push(node)
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      content.push({ type: "heading", attrs: { level: h[1].length }, content: inline(h[2].trim()) })
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      content.push({ type: "rule" })
      i++
      continue
    }
    if (LIST_RE.test(line)) {
      flush()
      content.push(parseList(LIST_RE.exec(line)![1].length))
      continue
    }
    if (/^>\s?/.test(line)) {
      flush()
      const q: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""))
      content.push({ type: "blockquote", content: [para(q.join(" "))] })
      continue
    }
    if (!line.trim()) {
      flush()
      i++
      continue
    }
    buf.push(line.trim())
    i++
  }
  flush()
  return { type: "doc", version: 1, content }
}

// ---------------------------------------------------------------------------
// ADF -> Markdown-ish text (for reading)
// ---------------------------------------------------------------------------

export function adfToText(node: Node | null | undefined, depth = 0): string {
  if (!node) return ""
  const kids = (n: Node, d = depth) => (n.content ?? []).map((c: Node) => adfToText(c, d)).join("")
  switch (node.type) {
    case "doc":
      return (node.content ?? []).map((c: Node) => adfToText(c, 0)).join("").replace(/\n{3,}/g, "\n\n").trim()
    case "text": {
      let t = node.text ?? ""
      for (const mk of node.marks ?? []) {
        if (mk.type === "strong") t = `**${t}**`
        else if (mk.type === "em") t = `*${t}*`
        else if (mk.type === "code") t = "`" + t + "`"
        else if (mk.type === "link") t = `[${t}](${mk.attrs?.href})`
      }
      return t
    }
    case "hardBreak":
      return "\n"
    case "paragraph":
      return kids(node) + "\n\n"
    case "heading":
      return "#".repeat(node.attrs?.level ?? 3) + " " + kids(node) + "\n\n"
    case "bulletList":
    case "orderedList":
      return (
        (node.content ?? [])
          .map((li: Node, idx: number) => {
            const marker = node.type === "orderedList" ? `${idx + 1}.` : "-"
            const body = (li.content ?? [])
              .map((c: Node) => (c.type.endsWith("List") ? "\n" + adfToText(c, depth + 1) : adfToText(c, depth + 1).trim()))
              .join("")
            return "  ".repeat(depth) + marker + " " + body.replace(/\n+$/, "")
          })
          .join("\n") + (depth === 0 ? "\n\n" : "")
      )
    case "codeBlock":
      return "```" + (node.attrs?.language ?? "") + "\n" + kids(node) + "\n```\n\n"
    case "blockquote":
      return kids(node).trim().split("\n").map((l: string) => "> " + l).join("\n") + "\n\n"
    case "rule":
      return "---\n\n"
    case "mention":
      return node.attrs?.text ?? "@user"
    case "inlineCard":
    case "blockCard":
      return node.attrs?.url ?? ""
    case "emoji":
      return node.attrs?.text ?? node.attrs?.shortName ?? ""
    default:
      return kids(node)
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function linkLines(links: Node[]): string[] {
  return (links ?? []).map((l) =>
    l.outwardIssue
      ? `- ${l.type.outward} ${l.outwardIssue.key} (${l.outwardIssue.fields?.summary ?? ""})`
      : `- ${l.type.inward} ${l.inwardIssue.key} (${l.inwardIssue.fields?.summary ?? ""})`,
  )
}

export const KEY = tool.schema.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/, "Issue key like CHAT-12").describe("Issue key, e.g. CHAT-12")

