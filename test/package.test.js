import { test } from "node:test"
import assert from "node:assert/strict"
import { Package } from "../src/package.js"

const raw = {
  name: "Example API",
  base_url: "https://api.example.com/",
  version: "2024-01-01",
  versions: ["2023-06-01", "2024-01-01"],
  endpoints: [
    {
      name: "find-user",
      docs: "Retrieves user data.",
      returns: "object",
      group: "Users",
      arguments: [{ name: "id", type: "string", required: true, docs: "Identifier of the user." }],
    },
  ],
  objects: [
    {
      name: "user",
      attributes: [{ name: "email", type: "string.email", nullable: false }],
    },
  ],
}

test("looks up endpoints by dash, underscore, or camelCase", () => {
  const pkg = Package.fromObject(raw)
  assert.equal(pkg.endpoint("find-user").docs, "Retrieves user data.")
  assert.equal(pkg.endpoint("find_user").name, "find-user")
  assert.equal(pkg.endpoint("findUser").name, "find-user")
  assert.equal(pkg.endpoint("doesNotExist"), null)
})

test("exposes endpoint arguments with type/required/docs", () => {
  const pkg = Package.fromObject(raw)
  const arg = pkg.endpoint("find-user").argument("id")
  assert.equal(arg.type.toString(), "string")
  assert.equal(arg.required, true)
  assert.equal(arg.optional, false)
  assert.equal(arg.docs, "Identifier of the user.")
})

test("reports versioned status and known versions", () => {
  const pkg = Package.fromObject(raw)
  assert.equal(pkg.versioned, true)
  assert.deepEqual(pkg.versions, ["2023-06-01", "2024-01-01"])
})

test("looks up object schemas by attribute context", () => {
  const pkg = Package.fromObject(raw)
  const user = pkg.object("user", { context: "attributes" })
  assert.equal(user.attributes[0].name, "email")
  assert.equal(pkg.object("user", { context: "arguments" }), null)
  assert.equal(pkg.object("does-not-exist"), null)
})

test("reports pipelining support based on presence of pipeline_url", () => {
  const withoutPipeline = Package.fromObject(raw)
  assert.equal(withoutPipeline.supportsPipelining, false)
  assert.equal(withoutPipeline.pipelineUrl, null)

  const withPipeline = Package.fromObject({ ...raw, pipeline_url: "https://api.example.com/pipeline" })
  assert.equal(withPipeline.supportsPipelining, true)
  assert.equal(withPipeline.pipelineUrl, "https://api.example.com/pipeline")
})
