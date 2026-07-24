/**
 * webfunction-js
 *
 * A JS client for the Web Function protocol (webfunction.org). Fetches a
 * package (the endpoint manifest) and exposes each declared endpoint as an
 * ordinary-looking method call: `client.listItems({ limit: 10 })`.
 */

import { execute, getJson } from "./request.js"
import { Package, normalizeName } from "./package.js"
import { wrapIfPaginated } from "./page.js"
import { Pipeline, escapeForPipeline } from "./pipeline.js"

/**
 * Property/symbol names that must NEVER be treated as an endpoint lookup.
 * Since `get` intercepts every property access on the client proxy, anything
 * that duck-types, inspects, serializes, or coerces the client object needs
 * to be excluded here or it would incorrectly trigger the "unknown endpoint"
 * check. Grouped by why each one matters:
 */
const NON_ENDPOINT_PROPS = new Set([
  // --- Promise / await machinery ---
  "then",
  "catch",
  "finally",

  // --- Serialization / coercion ---
  "toJSON",
  "toString",
  "valueOf",
  Symbol.toPrimitive,
  Symbol.toStringTag,

  // --- Iteration protocol ---
  Symbol.iterator,
  Symbol.asyncIterator,

  // --- Object/class internals ---
  "constructor",
  "prototype",
  "__proto__",
  "nodeType",

  // --- Framework/tooling duck-typing ---
  "$$typeof", // React element detection
  "asymmetricMatch", // Jest matcher detection

  // --- Node.js console/inspection ---
  Symbol.for("nodejs.util.inspect.custom"),
])

function joinUrl(baseUrl, endpointName) {
  return `${String(baseUrl).replace(/\/+$/, "")}/${String(endpointName).replace(/^\/+/, "")}`
}

export class Client {
  /**
   * Prefer the static builders (`fromPackageEndpoint`, `fromUrl`,
   * `fromPackage`) over calling this directly — they're the ones that
   * actually fetch/attach a package.
   *
   * @param {{ baseUrl: string, package?: Package|null, bearerAuth?: string|null, version?: string|null, pipelined?: boolean }} options
   */
  constructor({ baseUrl, package: pkg = null, bearerAuth = null, version = null, pipelined = false } = {}) {
    if (!baseUrl) {
      throw new TypeError("Client: baseUrl is required")
    }

    if (pipelined) {
      // A package signals pipelining support by declaring `pipeline_url`
      // (webfunction.org/pipelining, "Discovery"). Without it there's no
      // URL to send batched steps to.
      if (!pkg?.pipelineUrl) {
        throw new Error("Client: pipelined: true was requested, but the package does not declare a pipeline_url.")
      }
      this._pipeline = new Pipeline(pkg.pipelineUrl)
    } else {
      this._pipeline = null
    }

    this.baseUrl = baseUrl
    this.package = pkg
    this.bearerAuth = bearerAuth
    this.version = version
    this.pipelined = pipelined

    if (pkg) {
      for (const endpoint of pkg.endpoints) endpoint.setClient(this)
    }

    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (typeof prop === "symbol" || prop in target || NON_ENDPOINT_PROPS.has(prop)) {
          return Reflect.get(target, prop, receiver)
        }

        const endpoint = target.package?.endpoint(String(prop)) ?? null
        if (!endpoint) {
          // Matches Ruby's NoMethodError / PHP's BadMethodCallException:
          // calling an endpoint the package doesn't declare is an error,
          // not a silent pass-through to the server.
          throw new TypeError(`Undefined endpoint: ${String(prop)}`)
        }

        return (args = {}) => target.call(endpoint.name, args)
      },
    })
  }

  /**
   * Calls an endpoint by its raw (hyphenated) name, bypassing method-name
   * lookup. Under a pipelined client, this returns a PipelinePromise
   * synchronously (queued, not yet executed) rather than a real Promise —
   * call `.resolve()` on it, or `pipeline.execute()`, to actually run it.
   */
  call(endpointName, args = {}) {
    if (this.pipelined) {
      return this._queueStep(endpointName, args)
    }
    return this._executeCall(endpointName, args)
  }

  /** The underlying Pipeline for a pipelined client, or null otherwise. */
  get pipeline() {
    return this._pipeline
  }

  _buildHeaders() {
    const headers = {}
    if (this.bearerAuth) headers.Authorization = `Bearer ${this.bearerAuth}`
    if (this.version) headers["Api-Version"] = this.version
    return headers
  }

  _queueStep(endpointName, args) {
    const url = joinUrl(this.baseUrl, endpointName)
    return this._pipeline.addStep({
      url,
      headers: this._buildHeaders(),
      // Literal argument strings that happen to start with "$" must be
      // escaped, or the pipeline server will misread them as a broken
      // JSONPath reference (webfunction.org/pipelining, "Escaping").
      // Path/PipelinePromise values (genuine references) pass through as-is.
      body: escapeForPipeline(args),
    })
  }

  async _executeCall(endpointName, args) {
    const url = joinUrl(this.baseUrl, endpointName)
    const requestOnce = callArgs => execute(url, { bearerAuth: this.bearerAuth, version: this.version, args: callArgs })

    const raw = await requestOnce(args)
    return wrapIfPaginated(raw, requestOnce)
  }

  /**
   * Fetches the package by calling `url` as a Web Function endpoint (POST).
   */
  static async fromPackageEndpoint(url, { bearerAuth = null, version = null, pipelined = false } = {}) {
    const raw = await execute(url, { bearerAuth, version, args: {} })
    return Client.fromPackage(Package.fromObject(raw), { bearerAuth, version, pipelined })
  }

  /**
   * Fetches the package via a plain GET request instead of a Web Function
   * call. `version`, if given, is sent as an `api_version` query parameter
   * rather than an `Api-Version` header.
   */
  static async fromUrl(url, { bearerAuth = null, version = null, pipelined = false } = {}) {
    const raw = await getJson(url, { bearerAuth, version })
    return Client.fromPackage(Package.fromObject(raw), { bearerAuth, version, pipelined })
  }

  /** Builds a client from an already-constructed Package, avoiding an extra request. */
  static fromPackage(pkg, { bearerAuth = null, version = null, pipelined = false } = {}) {
    return new Client({ baseUrl: pkg.baseUrl, package: pkg, bearerAuth, version, pipelined })
  }
}

export { normalizeName }
