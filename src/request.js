import { BadRequestError, UnexpectedStatusCodeError, JsonParseError } from "./errors.js"

/**
 * The active HTTP client. Defaults to `fetch`. Swap it out (e.g. in tests, or
 * to use a different transport) with `setHttpClient`.
 *
 * A custom client receives (url, headers, bodyString) and must return
 * `[statusCode, rawBodyString]` — mirrors the Ruby gem's `http_client=`.
 */
let httpClient = defaultHttpClient

export function setHttpClient(fn) {
  httpClient = fn
}

export function resetHttpClient() {
  httpClient = defaultHttpClient
}

async function defaultHttpClient(url, headers, body) {
  const res = await fetch(url, { method: "POST", headers, body })
  const text = await res.text()
  return [res.status, text]
}

function buildHeaders({ bearerAuth, version } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" }
  if (bearerAuth) headers.Authorization = `Bearer ${bearerAuth}`
  if (version) headers["Api-Version"] = version
  return headers
}

function parseBody(rawBody) {
  if (rawBody === "" || rawBody === undefined) return null
  try {
    return JSON.parse(rawBody)
  } catch (cause) {
    throw new JsonParseError(rawBody, cause)
  }
}

/**
 * Executes a single Web Function call: POSTs `args` as the JSON body to
 * `url`, with bearer auth / version headers attached as configured.
 *
 * @param {string} url
 * @param {{ bearerAuth?: string|null, version?: string|null, args?: unknown }} options
 */
export async function execute(url, { bearerAuth = null, version = null, args = {} } = {}) {
  const headers = buildHeaders({ bearerAuth, version })
  const body = JSON.stringify(args)

  const [status, rawBody] = await httpClient(url, headers, body)
  const parsed = parseBody(rawBody)

  if (status === 200) return parsed

  if (status === 400) {
    if (Array.isArray(parsed) && parsed.length === 3) {
      const [code, message, details] = parsed
      throw new BadRequestError(code, message, details)
    }
    throw new BadRequestError("WFN_BAD_REQUEST_ERROR", "Bad request", parsed)
  }

  throw new UnexpectedStatusCodeError(status, parsed)
}

/**
 * Fetches a package document via plain GET (as opposed to calling a URL as a
 * Web Function endpoint via POST). Used by `Client.fromUrl`. A version, if
 * given, is added as an `api_version` query parameter rather than a header.
 */
export async function getJson(url, { bearerAuth = null, version = null } = {}) {
  const target = new URL(url)
  if (version) target.searchParams.set("api_version", version)

  const headers = bearerAuth ? { Authorization: `Bearer ${bearerAuth}` } : {}
  const res = await fetch(target.toString(), { headers })
  const text = await res.text()

  if (!res.ok) {
    throw new UnexpectedStatusCodeError(res.status, parseBody(text))
  }

  return parseBody(text)
}
