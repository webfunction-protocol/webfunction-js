import { Type } from "./types.js"

/**
 * Normalizes an endpoint or method name so dashes, underscores, and camelCase
 * all resolve to the same lookup key: "list-items", "list_items", and
 * "listItems" are all equivalent.
 */
export function normalizeName(name) {
  return String(name).replace(/[-_]/g, "").toLowerCase()
}

export class Argument {
  constructor(raw) {
    this.name = raw.name
    this.type = Type.parse(raw.type ?? null)
    this.required = Boolean(raw.required)
    this.choices = raw.choices ?? []
    this.docs = raw.docs ?? ""
  }

  get optional() {
    return !this.required
  }
}

export class Attribute {
  constructor(raw) {
    this.name = raw.name
    this.type = Type.parse(raw.type ?? null)
    this.nullable = Boolean(raw.nullable)
    this.values = raw.values ?? []
  }
}

export class DocumentedError {
  constructor(raw) {
    this.code = raw.code
    this.docs = raw.docs ?? ""
  }
}

/**
 * A named object schema (declared under a package's `objects` key). The same
 * object may be referenced in an "arguments" context or an "attributes"
 * context, so both member sets are exposed; callers ask for the one they need.
 */
export class ObjectSchema {
  constructor(raw) {
    this.name = raw.name
    this._rawArguments = raw.arguments ?? []
    this._rawAttributes = raw.attributes ?? []
  }

  get arguments() {
    return this._rawArguments.map(a => new Argument(a))
  }

  get attributes() {
    return this._rawAttributes.map(a => new Attribute(a))
  }
}

export class Endpoint {
  constructor(raw) {
    this.name = raw.name
    this.docs = raw.docs ?? ""
    this.returns = Type.parse(raw.returns ?? null)
    this.group = raw.group ?? null
    this.paginated = Boolean(raw.paginated)
    this.bearerAuth = Boolean(raw.bearer_auth)
    this.captureBearer = Boolean(raw.capture_bearer)
    this._rawArguments = raw.arguments ?? []
    this._rawErrors = raw.errors ?? []
    this._client = null
  }

  get arguments() {
    return this._rawArguments.map(a => new Argument(a))
  }

  argument(name) {
    return this.arguments.find(a => a.name === name) ?? null
  }

  get errors() {
    return this._rawErrors.map(e => new DocumentedError(e))
  }

  error(code) {
    return this.errors.find(e => e.code === code) ?? null
  }

  /** Attaches this endpoint to a client so `endpoint.call(args)` works directly. */
  setClient(client) {
    this._client = client
  }

  call(args = {}) {
    if (!this._client) {
      throw new Error(`Endpoint "${this.name}" is not attached to a client`)
    }
    return this._client.call(this.name, args)
  }
}

export class Package {
  constructor(raw) {
    this.name = raw.name ?? null
    this.baseUrl = raw.base_url
    this.docs = raw.docs ?? ""
    this.version = raw.version ?? null
    this.versions = raw.versions ?? []
    // Presence of `pipeline_url` is how a package signals pipelining support
    // (see webfunction.org/pipelining, "Discovery").
    this.pipelineUrl = raw.pipeline_url ?? null
    this._endpoints = (raw.endpoints ?? []).map(e => new Endpoint(e))
    this._rawObjects = raw.objects ?? []
    this._rawErrors = raw.errors ?? []
  }

  static fromObject(raw) {
    return new Package(raw ?? {})
  }

  get versioned() {
    return this.versions.length > 0
  }

  get supportsPipelining() {
    return this.pipelineUrl !== null
  }

  get endpoints() {
    return this._endpoints
  }

  endpoint(name) {
    const key = normalizeName(name)
    return this._endpoints.find(e => normalizeName(e.name) === key) ?? null
  }

  /**
   * @param {string} name
   * @param {{ context?: 'arguments'|'attributes' }} [options]
   * @returns {ObjectSchema|null} null if the object isn't defined, or defines
   *   no members for the requested context.
   */
  object(name, { context } = {}) {
    const raw = this._rawObjects.find(o => o.name === name)
    if (!raw) return null

    const schema = new ObjectSchema(raw)
    if (context === "arguments" && schema.arguments.length === 0) return null
    if (context === "attributes" && schema.attributes.length === 0) return null
    return schema
  }

  get objects() {
    return this._rawObjects.map(o => new ObjectSchema(o))
  }

  get errors() {
    return this._rawErrors.map(e => new DocumentedError(e))
  }

  error(code) {
    return this.errors.find(e => e.code === code) ?? null
  }
}
