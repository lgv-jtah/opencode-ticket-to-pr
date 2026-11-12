/**
 * Host-agnostic pull request creation for GitHub and Bitbucket Cloud.
 *
 * Kept free of opencode imports so it can be unit-tested with plain Node
 * (`node --test "tests/*.test.ts"`). The opencode tool wrapper lives in tools/pr.ts.
 *
 * Credentials (read from the environment of the opencode process):
 *   GitHub:    GITHUB_TOKEN (or GH_TOKEN) - fine-grained token, "Pull requests: read and write"
 *   Bitbucket: BITBUCKET_EMAIL + BITBUCKET_API_TOKEN - Atlassian API token with the
 *              scopes "read:pullrequest:bitbucket" and "write:pullrequest:bitbucket"
 */

export type Host = "github" | "bitbucket"

export interface RepoRef {
  host: Host
  /** GitHub owner or Bitbucket workspace. */
  owner: string
  /** Repository name / slug. */
  repo: string
}

export interface PullRequestInput {
  title: string
  body: string
  /** Source branch (must already be pushed). */
  head: string
  /** Target branch. */
  base: string
}

export interface PullRequestResult {
  url: string
  number: number
  /** True when an open PR for this head branch already existed and was returned instead. */
  existed: boolean
}

type Env = Record<string, string | undefined>
type Fetch = typeof fetch

const REMOTE_RE =
  /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?(github\.com|bitbucket\.org)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i

/** Parse a git remote URL (SSH, scp-like or HTTPS) into host, owner and repo. */
export function parseRemote(url: string): RepoRef {
  const m = REMOTE_RE.exec(url.trim())
  if (!m) {
    throw new Error(`Unsupported git remote '${url}': only github.com and bitbucket.org are supported.`)
  }
  return { host: m[1].toLowerCase() === "github.com" ? "github" : "bitbucket", owner: m[2], repo: m[3] }
}

/** Create a PR, or return the already open PR for the same head branch (idempotent). */
export async function createPullRequest(
  ref: RepoRef,
  input: PullRequestInput,
  opts: { env?: Env; signal?: AbortSignal; fetchImpl?: Fetch } = {},
): Promise<PullRequestResult> {
  if (input.head === input.base) throw new Error(`Head and base branch are both '${input.base}'.`)
  const env = opts.env ?? process.env
  const client = ref.host === "github" ? github(ref, env) : bitbucket(ref, env)
  const call = (method: string, path: string, body?: unknown) =>
    request(client, method, path, body, opts.fetchImpl ?? fetch, opts.signal)

  const existing = await client.findOpen(call, input)
  if (existing) return { ...existing, existed: true }
  return { ...(await client.create(call, input)), existed: false }
}

// ---------------------------------------------------------------------------
// Host clients
// ---------------------------------------------------------------------------

type Call = (method: string, path: string, body?: unknown) => Promise<any>

interface Client {
  base: string
  headers: Record<string, string>
  secret: string
  findOpen(call: Call, input: PullRequestInput): Promise<Omit<PullRequestResult, "existed"> | null>
  create(call: Call, input: PullRequestInput): Promise<Omit<PullRequestResult, "existed">>
}

function github(ref: RepoRef, env: Env): Client {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN
  if (!token) throw new Error("GitHub credentials missing: export GITHUB_TOKEN (or GH_TOKEN) and restart opencode.")
  const repo = `/repos/${enc(ref.owner)}/${enc(ref.repo)}`
  return {
    base: "https://api.github.com",
    secret: token,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    async findOpen(call, input) {
      const q = new URLSearchParams({ head: `${ref.owner}:${input.head}`, base: input.base, state: "open" })
      const prs: any[] = await call("GET", `${repo}/pulls?${q}`)
      return prs.length ? { url: prs[0].html_url, number: prs[0].number } : null
    },
    async create(call, input) {
      const pr = await call("POST", `${repo}/pulls`, {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
      })
      return { url: pr.html_url, number: pr.number }
    },
  }
}

function bitbucket(ref: RepoRef, env: Env): Client {
  const email = env.BITBUCKET_EMAIL
  const token = env.BITBUCKET_API_TOKEN
  if (!email || !token) {
    throw new Error("Bitbucket credentials missing: export BITBUCKET_EMAIL and BITBUCKET_API_TOKEN and restart opencode.")
  }
  const repo = `/2.0/repositories/${enc(ref.owner)}/${enc(ref.repo)}`
  return {
    base: "https://api.bitbucket.org",
    secret: token,
    headers: {
      Authorization: "Basic " + Buffer.from(`${email}:${token}`).toString("base64"),
      Accept: "application/json",
    },
    async findOpen(call, input) {
      const q = new URLSearchParams({
        q: `source.branch.name="${input.head}" AND destination.branch.name="${input.base}" AND state="OPEN"`,
      })
      const page = await call("GET", `${repo}/pullrequests?${q}`)
      const pr = page.values?.[0]
      return pr ? { url: pr.links.html.href, number: pr.id } : null
    },
    async create(call, input) {
      const pr = await call("POST", `${repo}/pullrequests`, {
        title: input.title,
        description: input.body,
        source: { branch: { name: input.head } },
        destination: { branch: { name: input.base } },
        close_source_branch: true,
      })
      return { url: pr.links.html.href, number: pr.id }
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 30_000

async function request(client: Client, method: string, path: string, body: unknown, fetchImpl: Fetch, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const res = await fetchImpl(client.base + path, {
    method,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { ...client.headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await res.text()
  if (!res.ok) {
    const detail = errorDetail(raw).split(client.secret).join("***")
    throw new Error(`${method} ${client.base}${path} failed: HTTP ${res.status} - ${detail}`)
  }
  return raw ? JSON.parse(raw) : {}
}

/** Extract the human-readable message from GitHub / Bitbucket error bodies. */
function errorDetail(raw: string): string {
  try {
    const j = JSON.parse(raw)
    const parts = [
      j.message, // GitHub
      ...(j.errors ?? []).map((e: any) => e.message ?? JSON.stringify(e)), // GitHub validation errors
      j.error?.message, // Bitbucket
      j.error?.detail ? JSON.stringify(j.error.detail) : undefined,
    ].filter(Boolean)
    if (parts.length) return parts.join("; ")
  } catch {}
  return raw.slice(0, 800)
}

const enc = encodeURIComponent
