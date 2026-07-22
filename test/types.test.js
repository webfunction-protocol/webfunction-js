import { test } from "node:test"
import assert from "node:assert/strict"
import { Type } from "../src/types.js"

test("parses base types", () => {
  assert.equal(Type.parse("string").toString(), "string")
  assert.equal(Type.parse(null).toString(), "any")
  assert.equal(Type.parse("array").toString(), "array<any>")
})

test("parses refined types and formats them", () => {
  const t = Type.parse("string.email")
  assert.equal(t.toString(), "string.email")
  assert.equal(t.format("base"), "string")
  assert.equal(t.format("compact"), "email")
})

test("parses unions from a top-level array", () => {
  assert.equal(Type.parse(["object", "null"]).toString(), "object | null")
})

test("parses arrays from a nested array", () => {
  assert.equal(Type.parse([["string"]]).toString(), "array<string>")
})

test("parses object references and reports them via .objects", () => {
  const t = Type.parse("object.user")
  assert.equal(t.toString(), "object.user")
  assert.deepEqual(t.objects, ["user"])
})

test("collects object refs from inside unions and arrays", () => {
  const t = Type.parse([["object.user"], "null"])
  assert.deepEqual(new Set(t.objects), new Set(["user"]))
})

test("validates values against refinements", () => {
  const email = Type.parse("string.email")
  assert.equal(email.valid("ada@example.com"), true)
  assert.equal(email.valid("not-an-email"), false)

  const uuid = Type.parse("string.uuid")
  assert.equal(uuid.valid("550e8400-e29b-41d4-a716-446655440000"), true)
  assert.equal(uuid.valid("nope"), false)
})

test("validates unions and arrays recursively", () => {
  const t = Type.parse(["object", "null"])
  assert.equal(t.valid(null), true)
  assert.equal(t.valid({}), true)
  assert.equal(t.valid("nope"), false)

  const arr = Type.parse([["number"]])
  assert.equal(arr.valid([1, 2, 3]), true)
  assert.equal(arr.valid([1, "two"]), false)
})
