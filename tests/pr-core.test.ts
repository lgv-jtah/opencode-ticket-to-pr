// Run with: node --test tests/
import assert from "node:assert/strict"
import { test } from "node:test"
import { createPullRequest, parseRemote } from "../.opencode/lib/pr-core.mts"

type Call = { method: string; url: string; body?: any; auth?: string; headers: Record<string, string> }

/** Fake fetch that records calls and replies with queued responses. */
function fakeFetch(replies: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = []
  const impl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    calls.push({
      method: init.method!,
      url,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      auth: headers.Authorization,
      headers,
    })
    const r = replies.shift()
    if (!r) throw new Error(`unexpected request ${init.method} ${url}`)
    return new Response(JSON.stringify(r.body), { status: r.status })
  }) as typeof fetch
  return { impl, calls }
}

const input = { title: "feat(x): add y", body: "Refs CHAT-1", head: "feature/CHAT-1-add-y", base: "main" }

test("parseRemote handles the remote styles used in practice", () => {
  assert.deepEqual(parseRemote("git@github.com:lgv-jtah/chat_with_your_map_backend.git"), {
    host: "github",
    owner: "lgv-jtah",
    repo: "chat_with_your_map_backend",
  })
  assert.deepEqual(parseRemote("https://JulienHofer@bitbucket.org/geowerkstatt-hamburg/masterportal.git"), {
    host: "bitbucket",
    owner: "geowerkstatt-hamburg",
    repo: "masterportal",
  })
  assert.deepEqual(parseRemote("ssh://git@github.com/o/r"), { host: "github", owner: "o", repo: "r" })
  assert.deepEqual(parseRemote("https://github.com/o/r.git/\n"), { host: "github", owner: "o", repo: "r" })
})

test("parseRemote rejects unsupported hosts and malformed paths", () => {
  assert.throws(() => parseRemote("git@gitea.example.com:o/r.git", {}), /Unsupported git remote/)
  assert.throws(() => parseRemote("git@gitlab.example.com:o/r.git", {}), /GITLAB_URL \(not set\)/)
  assert.throws(() => parseRemote("git@github.com:o/sub/r.git", {}), /Unsupported git remote/)
  assert.throws(() => parseRemote("https://gitlab.com/onlyrepo.git", {}), /Unsupported git remote/)
})

test("parseRemote recognises gitlab.com with nested groups", () => {
  assert.deepEqual(parseRemote("git@gitlab.com:group/sub/r.git", {}), {
    host: "gitlab",
    owner: "group/sub",
    repo: "r",
    instance: "https://gitlab.com",
  })
  assert.deepEqual(parseRemote("https://gitlab.com/o/r", {}), { host: "gitlab", owner: "o", repo: "r", instance: "https://gitlab.com" })
})

test("parseRemote recognises the self-hosted GitLab in GITLAB_URL, incl. SSH port and path prefix", () => {
  const env = { GITLAB_URL: "https://git.example.com/gitlab/" }
  const want = { host: "gitlab", owner: "team", repo: "app", instance: "https://git.example.com/gitlab" }
  assert.deepEqual(parseRemote("ssh://git@git.example.com:2222/team/app.git", env), want)
  assert.deepEqual(parseRemote("https://me@git.example.com/gitlab/team/app.git", env), want)
  assert.throws(() => parseRemote("git@x:o/r", { GITLAB_URL: "not a url" }), /GITLAB_URL 'not a url' is not a valid URL/)
})

test("github: creates a PR when none is open", async () => {
  const f = fakeFetch([
    { status: 200, body: [] },
    { status: 201, body: { html_url: "https://github.com/o/r/pull/7", number: 7 } },
  ])
  const pr = await createPullRequest({ host: "github", owner: "o", repo: "r" }, input, {
    env: { GITHUB_TOKEN: "t0k" },
    fetchImpl: f.impl,
  })
  assert.deepEqual(pr, { url: "https://github.com/o/r/pull/7", number: 7, existed: false })
  assert.match(f.calls[0].url, /\/repos\/o\/r\/pulls\?head=o%3Afeature%2FCHAT-1-add-y&base=main&state=open$/)
  assert.equal(f.calls[1].method, "POST")
  assert.deepEqual(f.calls[1].body, { title: input.title, body: input.body, head: input.head, base: "main" })
  assert.equal(f.calls[1].auth, "Bearer t0k")
})

test("bitbucket: returns the existing open PR instead of creating a duplicate", async () => {
  const f = fakeFetch([{ status: 200, body: { values: [{ id: 3, links: { html: { href: "https://bitbucket.org/w/r/pull-requests/3" } } }] } }])
  const pr = await createPullRequest({ host: "bitbucket", owner: "w", repo: "r" }, input, {
    env: { BITBUCKET_EMAIL: "me@example.com", BITBUCKET_API_TOKEN: "s3cret" },
    fetchImpl: f.impl,
  })
  assert.deepEqual(pr, { url: "https://bitbucket.org/w/r/pull-requests/3", number: 3, existed: true })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].auth, "Basic " + Buffer.from("me@example.com:s3cret").toString("base64"))
})

test("bitbucket: creates a PR with source and destination branches", async () => {
  const f = fakeFetch([
    { status: 200, body: { values: [] } },
    { status: 201, body: { id: 4, links: { html: { href: "https://bitbucket.org/w/r/pull-requests/4" } } } },
  ])
  const pr = await createPullRequest({ host: "bitbucket", owner: "w", repo: "r" }, { ...input, base: "dev" }, {
    env: { BITBUCKET_EMAIL: "me@example.com", BITBUCKET_API_TOKEN: "s3cret" },
    fetchImpl: f.impl,
  })
  assert.equal(pr.number, 4)
  assert.deepEqual(f.calls[1].body.source, { branch: { name: input.head } })
  assert.deepEqual(f.calls[1].body.destination, { branch: { name: "dev" } })
})

test("gitlab: creates an MR on the instance, addressing the project by its encoded path", async () => {
  const f = fakeFetch([
    { status: 200, body: [] },
    { status: 201, body: { iid: 12, web_url: "https://git.example.com/team/sub/app/-/merge_requests/12" } },
  ])
  const ref = { host: "gitlab" as const, owner: "team/sub", repo: "app", instance: "https://git.example.com" }
  const pr = await createPullRequest(ref, input, { env: { GITLAB_TOKEN: "glpat-x" }, fetchImpl: f.impl })
  assert.deepEqual(pr, { url: "https://git.example.com/team/sub/app/-/merge_requests/12", number: 12, existed: false })
  assert.equal(
    f.calls[0].url,
    "https://git.example.com/api/v4/projects/team%2Fsub%2Fapp/merge_requests?source_branch=feature%2FCHAT-1-add-y&target_branch=main&state=opened",
  )
  assert.equal(f.calls[1].method, "POST")
  assert.deepEqual(f.calls[1].body, {
    title: input.title,
    description: input.body,
    source_branch: input.head,
    target_branch: "main",
    remove_source_branch: true,
  })
  assert.equal(f.calls[1].headers["PRIVATE-TOKEN"], "glpat-x")
})

test("gitlab: returns the existing open MR and surfaces list-style error messages", async () => {
  const ref = { host: "gitlab" as const, owner: "o", repo: "r", instance: "https://gitlab.com" }
  const found = fakeFetch([{ status: 200, body: [{ iid: 5, web_url: "https://gitlab.com/o/r/-/merge_requests/5" }] }])
  const pr = await createPullRequest(ref, input, { env: { GITLAB_TOKEN: "glpat-x" }, fetchImpl: found.impl })
  assert.deepEqual(pr, { url: "https://gitlab.com/o/r/-/merge_requests/5", number: 5, existed: true })
  assert.equal(found.calls.length, 1)

  const failing = fakeFetch([
    { status: 200, body: [] },
    { status: 409, body: { message: ["Another open merge request already exists for this source branch: !5"] } },
  ])
  await assert.rejects(
    createPullRequest(ref, input, { env: { GITLAB_TOKEN: "glpat-x" }, fetchImpl: failing.impl }),
    /HTTP 409 - Another open merge request already exists/,
  )
  await assert.rejects(createPullRequest(ref, input, { env: {}, fetchImpl: fakeFetch([]).impl }), /export GITLAB_TOKEN/)
})

test("API errors surface the host's message and never leak the token", async () => {
  const f = fakeFetch([
    { status: 200, body: [] },
    { status: 422, body: { message: "Validation Failed", errors: [{ message: "No commits between main and x (t0k)" }] } },
  ])
  await assert.rejects(
    createPullRequest({ host: "github", owner: "o", repo: "r" }, input, { env: { GITHUB_TOKEN: "t0k" }, fetchImpl: f.impl }),
    (e: Error) => /HTTP 422 - Validation Failed; No commits between main and x \(\*\*\*\)/.test(e.message) && !e.message.includes("t0k"),
  )
})

test("missing credentials fail before any request", async () => {
  const f = fakeFetch([])
  await assert.rejects(
    createPullRequest({ host: "bitbucket", owner: "w", repo: "r" }, input, { env: {}, fetchImpl: f.impl }),
    /BITBUCKET_EMAIL and BITBUCKET_API_TOKEN/,
  )
  assert.equal(f.calls.length, 0)
})
