// Run with: node --test tests/
import assert from "node:assert/strict"
import { test } from "node:test"
import { createPullRequest, parseRemote } from "../.opencode/lib/pr-core.mts"

type Call = { method: string; url: string; body?: any; auth?: string }

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

test("parseRemote rejects unsupported hosts", () => {
  assert.throws(() => parseRemote("git@gitlab.com:o/r.git"), /Unsupported git remote/)
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
