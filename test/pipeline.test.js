import { test } from "node:test"
import assert from "node:assert/strict"
import { Pipeline, escapeForPipeline } from "../src/pipeline.js"
import { setHttpClient, resetHttpClient } from "../src/request.js"
import { UnresolvedPromiseError } from "../src/errors.js"

function fakeHttp(handler) {
  setHttpClient(async (url, headers, body) => handler(url, headers, JSON.parse(body)))
}

test("addStep returns a promise whose unresolved indexing yields a JSONPath string", () => {
  const pipeline = new Pipeline("https://pipe.example/exec")
  const user = pipeline.addStep({ url: "https://a", headers: {}, body: {} })

  assert.equal(String(user), "$[0]")
  assert.equal(String(user.id), "$[0].id")
  assert.equal(String(user.address.city), "$[0].address.city")
  assert.equal(JSON.stringify({ userId: user.id }), '{"userId":"$[0].id"}')
})

test("numeric-looking keys build array-index path segments", () => {
  const pipeline = new Pipeline("https://pipe.example/exec")
  const list = pipeline.addStep({ url: "https://a", headers: {}, body: {} })

  assert.equal(String(list[0]), "$[0][0]")
  assert.equal(String(list[0].name), "$[0][0].name")
})

test("reading .value before resolution throws UnresolvedPromiseError", () => {
  const pipeline = new Pipeline("https://pipe.example/exec")
  const user = pipeline.addStep({ url: "https://a", headers: {}, body: {} })
  assert.throws(() => user.value, UnresolvedPromiseError)
})

test("calling .resolve()/.value on a nested field reference throws clearly", () => {
  const pipeline = new Pipeline("https://pipe.example/exec")
  const user = pipeline.addStep({ url: "https://a", headers: {}, body: {} })
  assert.throws(() => user.id.resolve(), /only the top-level value/)
  assert.throws(() => user.id.value, /only the top-level value/)
})

test('execute({ returns: "all" }) fills every promise from the batch', async () => {
  fakeHttp((_url, _headers, body) => {
    assert.deepEqual(body.returns, "$")
    assert.equal(body.steps.length, 2)
    return [200, JSON.stringify([{ id: "1" }, { id: "2", userId: "1" }])]
  })

  const pipeline = new Pipeline("https://pipe.example/exec")
  const user = pipeline.addStep({ url: "https://a/find-user", headers: {}, body: { id: "1" } })
  const order = pipeline.addStep({
    url: "https://a/create-order",
    headers: {},
    body: { userId: user.id },
  })

  const result = await order.resolve()
  assert.deepEqual(result, { id: "2", userId: "1" })
  assert.deepEqual(user.value, { id: "1" }) // resolving one promise fills the whole batch
  resetHttpClient()
})

test("resolving a promise a second time does not re-run the pipeline", async () => {
  let callCount = 0
  fakeHttp(() => {
    callCount += 1
    return [200, JSON.stringify([{ id: "1" }])]
  })

  const pipeline = new Pipeline("https://pipe.example/exec")
  const user = pipeline.addStep({ url: "https://a", headers: {}, body: {} })

  await user.resolve()
  await user.resolve()

  assert.equal(callCount, 1)
  resetHttpClient()
})

test("after resolution, indexing into the promise returns real values, not paths", async () => {
  fakeHttp(() => [200, JSON.stringify([{ id: "1", address: { city: "Bangkok" } }])])

  const pipeline = new Pipeline("https://pipe.example/exec")
  const user = pipeline.addStep({ url: "https://a", headers: {}, body: {} })
  await user.resolve()

  assert.equal(user.address.city, "Bangkok")
  resetHttpClient()
})

test('execute({ returns: "last" }) fills only the last promise', async () => {
  fakeHttp((_url, _headers, body) => {
    assert.equal(body.returns, "$[-1:]")
    return [200, JSON.stringify({ id: "2" })]
  })

  const pipeline = new Pipeline("https://pipe.example/exec")
  const a = pipeline.addStep({ url: "https://a", headers: {}, body: {} })
  const b = pipeline.addStep({ url: "https://b", headers: {}, body: {} })

  const result = await pipeline.execute({ returns: "last" })
  assert.deepEqual(result, { id: "2" })
  assert.deepEqual(b.value, { id: "2" })
  assert.throws(() => a.value, UnresolvedPromiseError)
  resetHttpClient()
})

test("execute() with a JSONPath string returns the raw response and fills no promises", async () => {
  fakeHttp((_url, _headers, body) => {
    assert.equal(body.returns, "$[0].id")
    return [200, JSON.stringify("abc-123")]
  })

  const pipeline = new Pipeline("https://pipe.example/exec")
  const a = pipeline.addStep({ url: "https://a", headers: {}, body: {} })

  const result = await pipeline.execute({ returns: "$[0].id" })
  assert.equal(result, "abc-123")
  assert.throws(() => a.value, UnresolvedPromiseError)
  resetHttpClient()
})

test("toJSON on an unresolved reference is the raw path string, not a wrapper object", () => {
  const pipeline = new Pipeline("https://pipe.example/exec")
  const user = pipeline.addStep({ url: "https://a", headers: {}, body: {} })
  assert.equal(JSON.stringify(user.id), '"$[0].id"')
})

test("await on an unresolved promise does not hang or throw (not treated as thenable)", async () => {
  const pipeline = new Pipeline("https://pipe.example/exec")
  const user = pipeline.addStep({ url: "https://a", headers: {}, body: {} })
  const awaited = await user // must resolve to the proxy itself, not attempt `.then()`
  assert.equal(String(awaited), "$[0]")
})

test('escapeForPipeline escapes literal leading "$" strings but leaves everything else alone', () => {
  assert.equal(escapeForPipeline("$100"), "\\$100")
  assert.equal(escapeForPipeline("no dollar here"), "no dollar here")
  assert.equal(escapeForPipeline(42), 42)
  assert.equal(escapeForPipeline(null), null)
  assert.deepEqual(escapeForPipeline(["$1", "ok"]), ["\\$1", "ok"])
  assert.deepEqual(escapeForPipeline({ price: "$5", name: "ok" }), { price: "\\$5", name: "ok" })
  assert.deepEqual(escapeForPipeline({ nested: { deep: "$deep" } }), { nested: { deep: "\\$deep" } })
})

test("escapeForPipeline leaves Path/PipelinePromise references untouched", () => {
  const pipeline = new Pipeline("https://pipe.example/exec")
  const user = pipeline.addStep({ url: "https://a", headers: {}, body: {} })
  const userId = user.id // capture once: each access to user.id creates a new Path instance

  assert.equal(escapeForPipeline(userId), userId) // same reference, not rewrapped/escaped
  assert.deepEqual(JSON.stringify({ userId: escapeForPipeline(userId) }), '{"userId":"$[0].id"}')
})
