/**
 * A paginated response is a JSON object with `page`, `next`, and `previous`
 * keys. `next`/`previous` are opaque — you post them back to the same
 * endpoint to move between pages, you never build or inspect them yourself.
 */
function isPaginatedShape(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'page' in value &&
    'next' in value &&
    'previous' in value
  );
}

export class Page {
  #raw;
  #requester; // async (cursorBody) => raw response, already bound to the right endpoint

  constructor(raw, requester) {
    this.#raw = raw;
    this.#requester = requester;
  }

  get page() {
    return this.#raw.page;
  }

  get hasNext() {
    return this.#raw.next !== null && this.#raw.next !== undefined;
  }

  get hasPrevious() {
    return this.#raw.previous !== null && this.#raw.previous !== undefined;
  }

  async nextPage() {
    if (!this.hasNext) return null;
    const raw = await this.#requester(this.#raw.next);
    return wrapIfPaginated(raw, this.#requester);
  }

  async previousPage() {
    if (!this.hasPrevious) return null;
    const raw = await this.#requester(this.#raw.previous);
    return wrapIfPaginated(raw, this.#requester);
  }

  [Symbol.iterator]() {
    return this.#raw.page[Symbol.iterator]();
  }

  map(fn) {
    return this.#raw.page.map(fn);
  }
}

/** Wraps `raw` in a Page if it matches the pagination shape, else returns it as-is. */
export function wrapIfPaginated(raw, requester) {
  return isPaginatedShape(raw) ? new Page(raw, requester) : raw;
}
