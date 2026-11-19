/**
 * Pull request tool for opencode: `pr_create`.
 *
 * Detects GitHub, Bitbucket or GitLab from the git remote and opens a PR
 * (merge request on GitLab) through the host's REST API (no `gh` / `glab` CLI needed). Asks for approval via the
 * "pr_write" permission. See lib/pr-core.mts for the credentials it needs.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { tool } from "@opencode-ai/plugin"
import { createPullRequest, parseRemote } from "../lib/pr-core.mts"

const s = tool.schema
const run = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, timeout: 15_000 })).stdout.trim()
}

export const create = tool({
  description:
    "Open a pull request on GitHub or Bitbucket, or a merge request on GitLab (detected from the git remote), from the current branch. " +
    "The branch must already be pushed. Returns the PR URL; if an open PR for the branch exists, returns that one. " +
    "Asks the user for approval.",
  args: {
    title: s.string().min(1).max(200).describe("PR title, e.g. the Conventional Commit header"),
    body: s.string().min(1).describe("PR description in Markdown"),
    base: s.string().min(1).describe("Target branch, e.g. main or dev"),
    head: s.string().min(1).optional().describe("Source branch (default: current branch)"),
    remote: s.string().min(1).optional().describe("Git remote to read the host from (default: origin)"),
  },
  async execute(args, ctx) {
    const cwd = ctx.worktree || ctx.directory
    const head = args.head ?? (await git(cwd, "branch", "--show-current"))
    if (!head) throw new Error("Detached HEAD: pass 'head' explicitly or switch to the feature branch.")
    const ref = parseRemote(await git(cwd, "remote", "get-url", args.remote ?? "origin"))
    const kind = ref.host === "gitlab" ? "MR" : "PR"
    const id = (n: number) => (ref.host === "gitlab" ? `!${n}` : `#${n}`)

    await ctx.ask({
      permission: "pr_write",
      patterns: [`create ${ref.host}:${ref.owner}/${ref.repo} ${head} -> ${args.base}`],
      always: [`create ${ref.host}:${ref.owner}/${ref.repo} *`],
      metadata: { host: ref.host, repo: `${ref.owner}/${ref.repo}`, head, base: args.base, title: args.title },
    })

    const pr = await createPullRequest(ref, { title: args.title, body: args.body, head, base: args.base }, { signal: ctx.abort })
    ctx.metadata({ title: `${pr.existed ? "Existing" : "Opened"} ${kind} ${id(pr.number)}` })
    return `${pr.existed ? `An open ${kind} already existed` : `Opened ${kind}`} ${id(pr.number)} (${ref.host}): ${pr.url}`
  },
})
