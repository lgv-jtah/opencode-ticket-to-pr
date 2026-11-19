/**
 * Host-agnostic pull request creation for GitHub, Bitbucket Cloud and GitLab
 * (gitlab.com or one self-hosted instance). GitLab calls them merge requests.
 *
 * Kept free of opencode imports so it can be unit-tested with plain Node
 * (`node --test "tests/*.test.ts"`). The opencode tool wrapper lives in tools/pr.ts.
 *
 * Credentials (read from the environment of the opencode process):
 *   GitHub:    GITHUB_TOKEN (or GH_TOKEN) - fine-grained token, "Pull requests: read and write"
 *   Bitbucket: BITBUCKET_EMAIL + BITBUCKET_API_TOKEN - Atlassian API token with the
 *              scopes "read:pullrequest:bitbucket" and "write:pullrequest:bitbucket"
 *   GitLab:    GITLAB_TOKEN - personal, group or project access token with the "api" scope
 *              GITLAB_URL (optional) - self-hosted instance, e.g. https://gitlab.example.com;
 *              remotes on gitlab.com are always recognised
 */

export type Host = "github" | "bitbucket" | "gitlab"

export interface RepoRef {
  host: Host
  /** GitHub owner, Bitbucket workspace or GitLab namespace (may contain '/' for subgroups). */
  owner: string
  /** Repository name / slug. */
  repo: string
  /** GitLab only: instance URL without trailing slash, e.g. https://gitlab.com. */
  instance?: string
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

const GITLAB_COM = "https://gitlab.com"

/** Split a git remote URL (scheme://[user@]host[:port]/path or scp-like [user@]host:path) into hostname and path. */
function splitRemote(url: string): { hostname: string; path: string } | null {
  const u = url.trim()
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u)
  const scp = scheme ? null : /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(u)
  const m = scheme ?? scp
  if (!m) return null
  const path = m[2].replace(/\/+$/, "").replace(/\.git$/i, "")
  return { hostname: m[1].toLowerCase(), path }
}

/** GitLab instances to recognise: gitlab.com plus GITLAB_URL, if set. */
function gitlabInstances(env: Env): URL[] {
  const out = [new URL(GITLAB_COM)]
  const custom = env.GITLAB_URL?.trim()
  if (custom) {
    let u: URL
    try {
      u = new URL(custom)
    } catch {
      throw new Error(`GITLAB_URL '${custom}' is not a valid URL (expected e.g. https://gitlab.example.com).`)
    }
    if (u.hostname !== "gitlab.com") out.unshift(u)
  }
  return out
}

/**
 * Parse a git remote URL (SSH, scp-like or HTTPS) into host, owner and repo.
 * GitHub and Bitbucket are detected by hostname; GitLab by gitlab.com or the hostname of GITLAB_URL.
 */
export function parseRemote(url: string, env: Env = process.env): RepoRef {
  const r = splitRemote(url)
  const unsupported = () =>
    new Error(
      `Unsupported git remote '${url.trim()}': expected github.com, bitbucket.org, gitlab.com` +
        ` or the GitLab instance in GITLAB_URL${env.GITLAB_URL ? ` (${env.GITLAB_URL})` : " (not set)"}.`,
    )
  if (!r) throw unsupported()
  const parts = r.path.split("/").filter(Boolean)

  if (r.hostname === "github.com" || r.hostname === "bitbucket.org") {
    if (parts.length !== 2) throw unsupported()
    return { host: r.hostname === "github.com" ? "github" : "bitbucket", owner: parts[0], repo: parts[1] }
  }

  const gl = gitlabInstances(env).find((i) => i.hostname === r.hostname)
  if (!gl) throw unsupported()
  // A self-hosted instance may live under a path prefix (https://example.com/gitlab); HTTPS remotes then include it.
  const prefix = gl.pathname.split("/").filter(Boolean)
  const rest = prefix.every((p, i) => parts[i] === p) ? parts.slice(prefix.length) : parts
  if (rest.length < 2) throw unsupported()
  return {
    host: "gitlab",
    owner: rest.slice(0, -1).join("/"),
    repo: rest[rest.length - 1],
    instance: (gl.origin + gl.pathname).replace(/\/+$/, ""),
  }
}

/** Create a PR, or return the already open PR for the same head branch (idempotent). */
export async function createPullRequest(
  ref: RepoRef,
  input: PullRequestInput,
  opts: { env?: Env; signal?: AbortSignal; fetchImpl?: Fetch } = {},
): Promise<PullRequestResult> {
  if (input.head === input.base) throw new Error(`Head and base branch are both '${input.base}'.`)
  const env = opts.env ?? process.env
  const client = { github, bitbucket, gitlab }[ref.host](ref, env)
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

function gitlab(ref: RepoRef, env: Env): Client {
  const token = env.GITLAB_TOKEN
  if (!token) throw new Error("GitLab credentials missing: export GITLAB_TOKEN and restart opencode.")
  // GitLab addresses a project by its URL-encoded full path, e.g. group%2Fsub%2Frepo.
  const project = `/api/v4/projects/${enc(`${ref.owner}/${ref.repo}`)}`
  return {
    base: ref.instance ?? GITLAB_COM,
    secret: token,
    headers: { "PRIVATE-TOKEN": token, Accept: "application/json" },
    async findOpen(call, input) {
      const q = new URLSearchParams({ source_branch: input.head, target_branch: input.base, state: "opened" })
      const mrs: any[] = await call("GET", `${project}/merge_requests?${q}`)
      return mrs.length ? { url: mrs[0].web_url, number: mrs[0].iid } : null
    },
    async create(call, input) {
      const mr = await call("POST", `${project}/merge_requests`, {
        title: input.title,
        description: input.body,
        source_branch: input.head,
        target_branch: input.base,
        remove_source_branch: true,
      })
      return { url: mr.web_url, number: mr.iid }
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

/** Extract the human-readable message from GitHub / Bitbucket / GitLab error bodies. */
function errorDetail(raw: string): string {
  try {
    const j = JSON.parse(raw)
    const parts = [
      // GitHub and GitLab use a string; GitLab also sends a list or a {field: [messages]} object.
      typeof j.message === "string" ? j.message : undefined,
      Array.isArray(j.message) ? j.message.join("; ") : undefined,
      j.message && typeof j.message === "object" && !Array.isArray(j.message) ? JSON.stringify(j.message) : undefined,
      ...(Array.isArray(j.errors) ? j.errors : []).map((e: any) => e.message ?? JSON.stringify(e)), // GitHub validation errors
      typeof j.error === "string" ? j.error : undefined, // GitLab (e.g. 401, 404)
      j.error?.message, // Bitbucket
      j.error?.detail ? JSON.stringify(j.error.detail) : undefined,
    ].filter(Boolean)
    if (parts.length) return parts.join("; ")
  } catch {}
  return raw.slice(0, 800)
}

const enc = encodeURIComponent
