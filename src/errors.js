/**
 * Base error for everything this library raises. Mirrors WebFunction::Error
 * from the Ruby gem: every error carries a `code` and optional `details`.
 */
export class WfnError extends Error {
  constructor(message, { code = 'WFN_ERROR', details = null, cause } = {}) {
    super(message);
    this.name = 'WfnError';
    this.code = code;
    this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Raised when the server responds with status 400. The body is expected to
 * be an "error triple": a JSON array of [code, message, details]. If the
 * body isn't a triple, we still raise this with a generic code and the raw
 * body as details (matching the Ruby gem's fallback behavior).
 */
export class BadRequestError extends WfnError {
  constructor(code, message, details) {
    super(message, { code, details });
    this.name = 'BadRequestError';
  }
}

/** Raised when the server responds with any status other than 200 or 400. */
export class UnexpectedStatusCodeError extends WfnError {
  constructor(status, body) {
    super(`Unexpected status code: ${status}`, {
      code: 'WFN_UNEXPECTED_STATUS',
      details: body,
    });
    this.name = 'UnexpectedStatusCodeError';
    this.status = status;
  }
}

/** Raised when the response body could not be parsed as JSON. */
export class JsonParseError extends WfnError {
  constructor(rawBody, cause) {
    super('Response body was not valid JSON', {
      code: 'WFN_JSON_PARSE_ERROR',
      details: rawBody,
      cause,
    });
    this.name = 'JsonParseError';
  }
}

/**
 * Raised when a pipeline promise is read before it resolves. Reserved for
 * the pipelining feature, which isn't implemented yet — see README.
 */
export class UnresolvedPromiseError extends WfnError {
  constructor() {
    super('A pipeline promise was read before it resolved', {
      code: 'WFN_UNRESOLVED_PROMISE',
    });
    this.name = 'UnresolvedPromiseError';
  }
}
