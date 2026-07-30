import { execute } from "./request.js"
import { UnresolvedPromiseError } from "./errors.js"

/**
 * Property/symbol names that must never be treated as a path segment, for
 * the same reasons as the client's guard list (promise/await machinery,
 * serialization, iteration, framework duck-typing). See client.js for the
 * fuller rationale — kept short here since toJSON/toString are real methods
 * on these classes and handled separately below.
 */
const NON_FIELD_PROPS = new Set([
  "then",
  "catch",
  "finally",
  "valueOf",
  Symbol.toPrimitive,
  Symbol.toStringTag,
  Symbol.iterator,
  Symbol.asyncIterator,
  "__proto__",
  "$$typeof",
  "asymmetricMatch",
  Symbol.for("nodejs.util.inspect.custom"),
])

function isIndexKey(key) {
  return typeof key === "string" && /^\d+$/.test(key)
}

/**
 * Forwards a `get` trap's real-member lookups to `target`, binding any
 * function result (and running any getter) against `target` rather than the
 * proxy. Necessary because private class fields (#foo) are keyed to the
 * exact object identity that declared them — if a method is later invoked as
 * `proxy.method()`, `this` inside it is the proxy, not the real instance,
 * and touching a private field then throws. Binding sidesteps that.
 */
function forwardRealMember(target, prop) {
  const value = Reflect.get(target, prop, target)
  return typeof value === "function" ? value.bind(target) : value
}

/**
 * A path is a JSONPath expression accumulated by indexing into a not-yet
 * resolved pipeline value, e.g. `$[0].address.city`. It has no awareness of
 * the pipeline and cannot be resolved directly — only the top-level
 * PipelinePromise a call returns supports that.
 */
export class Path {
  #expr

  constructor(expr) {
    this.#expr = expr
  }

  toString() {
    return this.#expr
  }

  toJSON() {
    return this.#expr
  }

  at(key) {
    return isIndexKey(key) ? new Path(`${this.#expr}[${key}]`) : new Path(`${this.#expr}.${key}`)
  }
}

function wrapPath(path) {
  return new Proxy(path, {
    get(target, prop) {
      if (typeof prop === "symbol") {
        return NON_FIELD_PROPS.has(prop) ? undefined : forwardRealMember(target, prop)
      }
      if (prop in target) return forwardRealMember(target, prop)
      if (NON_FIELD_PROPS.has(prop)) return undefined
      if (prop === "resolve" || prop === "value") {
        throw new TypeError(
          `Cannot call .${prop}() here — only the top-level value returned by a ` + "pipelined call supports resolve()/value, not a nested field reference."
        )
      }
      return wrapPath(target.at(prop))
    },
  })
}

/**
 * Stands in for a value a pipelined call hasn't produced yet. Indexing into
 * it before the pipeline runs (`user['id']`) returns a Path reference — not
 * a value — which serializes as that path expression when embedded in a
 * later step's args. This is NOT a real JS Promise: nothing runs
 * automatically and it is not `await`-able; call `.resolve()` to actually
 * run the pipeline.
 */
export class PipelinePromise {
  #pipeline
  #path
  #value
  #hasValue = false

  constructor(pipeline, pathExpr) {
    this.#pipeline = pipeline
    this.#path = new Path(pathExpr)
  }

  /** @internal — called by Pipeline#execute once the batch has actually run. */
  _setValue(value) {
    this.#value = value
    this.#hasValue = true
  }

  get value() {
    if (!this.#hasValue) throw new UnresolvedPromiseError()
    return this.#value
  }

  /** Runs the pipeline batch if it hasn't run yet, then returns this value. */
  async resolve() {
    if (this.#hasValue) return this.#value
    await this.#pipeline.execute()
    return this.value
  }

  toString() {
    return this.#hasValue ? String(this.#value) : this.#path.toString()
  }

  toJSON() {
    return this.#hasValue ? this.#value : this.#path.toJSON()
  }

  at(key) {
    if (this.#hasValue) {
      return this.#value?.[isIndexKey(key) ? Number(key) : key]
    }
    return this.#path.at(key)
  }
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Escapes literal string values that would otherwise be misread as a
 * JSONPath reference by the pipeline server (webfunction.org/pipelining,
 * "Escaping": a string is only a reference if the *entire* value is a
 * JSONPath starting with an unescaped `$`; a literal `$100` must become
 * `\$100`). Leaves `Path`/`PipelinePromise` values alone — those are
 * genuine references and must serialize as-is. Walks plain objects and
 * arrays; anything else (numbers, booleans, dates, class instances, and the
 * Path/PipelinePromise proxies, which still pass `instanceof` since neither
 * wrapper overrides the prototype trap) passes through untouched.
 */
export function escapeForPipeline(value) {
  if (value instanceof Path || value instanceof PipelinePromise) return value
  if (Array.isArray(value)) return value.map(escapeForPipeline)
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, escapeForPipeline(v)]))
  }
  if (typeof value === "string" && value.startsWith("$")) return `\\${value}`
  return value
}

function wrapPromise(promise) {
  return new Proxy(promise, {
    get(target, prop) {
      if (typeof prop === "symbol") {
        return NON_FIELD_PROPS.has(prop) ? undefined : forwardRealMember(target, prop)
      }
      if (prop in target) return forwardRealMember(target, prop)
      if (NON_FIELD_PROPS.has(prop)) return undefined

      const result = target.at(prop)
      return result instanceof Path ? wrapPath(result) : result
    },
  })
}

/**
 * Batches steps ({ url, headers, body }) and executes them as a single
 * request. `addStep` immediately returns a PipelinePromise; nothing runs
 * until `execute()` is called (directly, or via a promise's `.resolve()`).
 */
export class Pipeline {
  #url
  #steps = []
  #promises = []

  constructor(url) {
    this.#url = url
  }

  /** Number of steps queued but not yet executed. */
  get pendingCount() {
    return this.#steps.length
  }

  addStep(step) {
    const n = this.#promises.length
    const promise = new PipelinePromise(this, `$[${n}]`)
    this.#steps.push(step)
    this.#promises.push(promise)
    return wrapPromise(promise)
  }

  /**
   * @param {{ returns?: 'all'|'last'|string }} [options]
   *   'all' (default): every step's result as an array; fills every promise.
   *   'last': only the last step's result; fills only the last promise.
   *   a JSONPath string: whatever the server returns for that expression;
   *     matches the Ruby gem in NOT filling any promise in this case.
   */
  async execute({ returns = "all" } = {}) {
    if (returns === "all") {
      const responses = await execute(this.#url, { args: { steps: this.#steps, returns: "$" } })
      responses.forEach((response, index) => this.#promises[index]._setValue(response))
      this.#reset()
      return responses
    }

    if (returns === "last") {
      const response = await execute(this.#url, { args: { steps: this.#steps, returns: "$[-1:]" } })
      this.#promises[this.#promises.length - 1]._setValue(response)
      this.#reset()
      return response
    }

    const response = await execute(this.#url, { args: { steps: this.#steps, returns } })
    this.#reset()
    return response
  }

  #reset() {
    this.#steps = []
    this.#promises = []
  }
}
