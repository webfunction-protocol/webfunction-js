/**
 * Parses and represents Web Function type declarations. A type comes from a
 * package as one of:
 *   - null                      -> any
 *   - "string" | "object" | ... -> a base type
 *   - "string.email"            -> a base type with a refinement
 *   - "object.user"             -> a reference to a named object schema
 *   - "array"                   -> array<any>
 *   - [t1, t2, ...] (top-level) -> union of t1 | t2 | ...
 *   - [[t]] (nested array)      -> array<t>
 */

const STRING_REFINEMENTS = new Set([
  'date', 'time', 'datetime', 'uuid', 'base64', 'email', 'phone',
  'url', 'uri', 'ipv4', 'ipv6', 'hostname',
]);

const NUMBER_REFINEMENTS = new Set(['u32', 'u64', 'i32', 'i64', 'f32', 'f64', 'timestamp']);

export class Type {
  #node;

  constructor(node) {
    this.#node = node;
  }

  static parse(value) {
    return new Type(parseNode(value));
  }

  toString() {
    return nodeToString(this.#node);
  }

  /**
   * @param {'full'|'base'|'compact'} mode
   *   full (default): the full type string, e.g. "string.email"
   *   base: just the base kind, e.g. "string"
   *   compact: refinement if present, else the base, e.g. "email"
   */
  format(mode = 'full') {
    if (mode === 'base') return this.#node.kind;
    if (mode === 'compact') return nodeCompact(this.#node);
    return this.toString();
  }

  /** Names of any `object.<name>` references found anywhere in this type. */
  get objects() {
    const found = new Set();
    collectObjects(this.#node, found);
    return [...found];
  }

  /** Validates a value against this type (including refinements, recursively). */
  valid(value) {
    return validate(this.#node, value);
  }
}

function parseNode(value) {
  if (value === null || value === undefined) return { kind: 'any' };

  if (Array.isArray(value)) {
    // A single nested array denotes "array of" the inner type: [["string"]] -> array<string>
    if (value.length === 1 && Array.isArray(value[0])) {
      return { kind: 'array', of: parseNode(value[0]) };
    }
    // Any other top-level array is a union of its parsed elements.
    return { kind: 'union', options: value.map(parseNode) };
  }

  if (typeof value === 'string') {
    if (value === 'array') return { kind: 'array', of: { kind: 'any' } };

    const [base, refinement] = value.split('.');

    if (base === 'object' && refinement) {
      return { kind: 'object', ref: refinement };
    }

    return { kind: base, refinement: refinement ?? null };
  }

  throw new TypeError(`Cannot parse Web Function type: ${JSON.stringify(value)}`);
}

function nodeToString(node) {
  switch (node.kind) {
    case 'any':
      return 'any';
    case 'union':
      return node.options.map(nodeToString).join(' | ');
    case 'array':
      return `array<${nodeToString(node.of)}>`;
    case 'object':
      return node.ref ? `object.${node.ref}` : 'object';
    case 'string':
    case 'number':
      return node.refinement ? `${node.kind}.${node.refinement}` : node.kind;
    default:
      return node.kind;
  }
}

function nodeCompact(node) {
  if ((node.kind === 'string' || node.kind === 'number') && node.refinement) {
    return node.refinement;
  }
  return nodeToString(node);
}

function collectObjects(node, found) {
  if (node.kind === 'object' && node.ref) found.add(node.ref);
  if (node.kind === 'union') node.options.forEach((n) => collectObjects(n, found));
  if (node.kind === 'array') collectObjects(node.of, found);
}

function validate(node, value) {
  switch (node.kind) {
    case 'any':
      return true;
    case 'union':
      return node.options.some((n) => validate(n, value));
    case 'array':
      return Array.isArray(value) && value.every((v) => validate(node.of, v));
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string' && validateStringRefinement(node.refinement, value);
    case 'number':
      return typeof value === 'number' && validateNumberRefinement(node.refinement, value);
    default:
      return true;
  }
}

// NOTE: these are pragmatic checks, not exhaustive spec-grade validators —
// good enough to catch obviously-wrong values, not to replace server-side
// validation.
function validateStringRefinement(refinement, value) {
  if (!refinement) return true;
  if (!STRING_REFINEMENTS.has(refinement)) return true; // unknown refinement: don't block

  switch (refinement) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'uuid':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    case 'url':
    case 'uri':
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    case 'ipv4':
      return /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
    case 'ipv6':
      return /^[0-9a-f:]+$/i.test(value) && value.includes(':');
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'time':
      return /^\d{2}:\d{2}:\d{2}/.test(value);
    case 'datetime':
      return !Number.isNaN(Date.parse(value));
    case 'base64':
      return /^[A-Za-z0-9+/]*={0,2}$/.test(value);
    case 'hostname':
      return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(value);
    case 'phone':
      return /^[+\d][\d\s\-().]{5,}$/.test(value);
    default:
      return true;
  }
}

function validateNumberRefinement(refinement, value) {
  if (!refinement) return true;
  if (!NUMBER_REFINEMENTS.has(refinement)) return true;

  if (refinement.startsWith('u')) return Number.isInteger(value) && value >= 0;
  if (refinement.startsWith('i')) return Number.isInteger(value);
  if (refinement.startsWith('f')) return true;
  if (refinement === 'timestamp') return Number.isFinite(value) && value >= 0;

  return true;
}
