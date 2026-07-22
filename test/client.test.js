import { test } from "node:test"
import assert from "node:assert/strict"
import { Client, setHttpClient, resetHttpClient, Package, BadRequestError } from "../src/index.js"

const SAMPLE_PACKAGE = {
  name: "Example API",
  base_url: "https://api.example.com/",
  endpoints: [
    { name: "list-items", returns: [["object"]] },
    { name: "find-user", returns: "object", arguments: [{ name: "id", type: "string", required: true }] },
  ],
}

function fakeClient(handler, pkgOverrides = {}) {
  setHttpClient(async (url, headers, body) => handler(url, headers, JSON.parse(body)))
  const pkg = Package.fromObject({ ...SAMPLE_PACKAGE, ...pkgOverrides })
  return Client.fromPackage(pkg)
}

test("calls the matching endpoint using a single args object", async () => {
  let captured
  const client = fakeClient((url, _headers, body) => {
    captured = { url, body }
    return [200, JSON.stringify({ id: "123", name: "Ada" })]
  })

  const result = await client.findUser({ id: "123" })

  assert.equal(captured.url, "https://api.example.com/find-user")
  assert.deepEqual(captured.body, { id: "123" })
  assert.deepEqual(result, { id: "123", name: "Ada" })
  resetHttpClient()
})

test("normalizes camelCase, snake_case, and hyphenated names to the same endpoint", async () => {
  const calledUrls = []
  const client = fakeClient(url => {
    calledUrls.push(url)
    return [200, JSON.stringify([])]
  })

  await client.listItems()
  await client.list_items()
  await client.call("list-items")

  assert.deepEqual(calledUrls, Array(3).fill("https://api.example.com/list-items"))
  resetHttpClient()
})

test("throws on an endpoint the package does not declare", async () => {
  const client = fakeClient(() => [200, "{}"])
  assert.throws(() => client.doesNotExist, /Undefined endpoint: doesNotExist/)
  resetHttpClient()
})

test("sends bearer auth and version headers when configured", async () => {
  let capturedHeaders
  setHttpClient(async (_url, headers, body) => {
    capturedHeaders = headers
    return [200, JSON.stringify([])]
  })

  const pkg = Package.fromObject(SAMPLE_PACKAGE)
  const client = Client.fromPackage(pkg, { bearerAuth: "my-token", version: "2024-01-01" })
  await client.listItems()

  assert.equal(capturedHeaders.Authorization, "Bearer my-token")
  assert.equal(capturedHeaders["Api-Version"], "2024-01-01")
  resetHttpClient()
})

test("parses a 400 error triple into a BadRequestError", async () => {
  const client = fakeClient(() => [400, JSON.stringify(["USER_NOT_FOUND", "No user with that id.", { id: "missing" }])])

  await assert.rejects(
    () => client.findUser({ id: "missing" }),
    err => {
      assert.ok(err instanceof BadRequestError)
      assert.equal(err.code, "USER_NOT_FOUND")
      assert.equal(err.message, "No user with that id.")
      assert.deepEqual(err.details, { id: "missing" })
      return true
    }
  )
  resetHttpClient()
})

test("wraps a page-shaped response in a Page and can navigate to the next page", async () => {
  let callCount = 0
  const client = fakeClient((_url, _headers, body) => {
    callCount += 1
    if (callCount === 1) {
      return [200, JSON.stringify({ page: [{ id: 1 }], next: { cursor: "abc" }, previous: null })]
    }
    assert.deepEqual(body, { cursor: "abc" })
    return [200, JSON.stringify({ page: [{ id: 2 }], next: null, previous: { cursor: "zzz" } })]
  })

  const page = await client.listItems()
  assert.deepEqual(page.page, [{ id: 1 }])
  assert.equal(page.hasNext, true)
  assert.equal(page.hasPrevious, false)

  const next = await page.nextPage()
  assert.deepEqual(next.page, [{ id: 2 }])
  assert.equal(next.hasNext, false)
  assert.equal(next.hasPrevious, true)
  resetHttpClient()
})

test("guards common duck-typing props from being treated as endpoint lookups", async () => {
  const client = fakeClient(() => [200, "{}"])
  assert.equal(client.toJSON, undefined)
  assert.equal(client[Symbol.iterator], undefined)
  assert.doesNotThrow(() => client.constructor)
  resetHttpClient()
})

test("refuses to construct a pipelined client (not implemented yet)", () => {
  const pkg = Package.fromObject(SAMPLE_PACKAGE)
  assert.throws(() => Client.fromPackage(pkg, { pipelined: true }), /pipelining is not implemented/)
})
