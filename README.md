# webfunction-js

JS client for the [Web Function](https://webfunction.org) protocol, modeled
on [Robin Clart's Ruby gem](https://github.com/robinclart/web_function).

A Web Function API publishes a **package**: a JSON document listing its
endpoints, their arguments, return types, and docs. This library reads a
package and turns each endpoint into an ordinary-looking method call.

```js
import { Client } from 'webfunction-js';

const client = await Client.fromPackageEndpoint('https://api.example.com/package');

await client.findUser({ id: '123' });
// => { id: '123', name: 'Ada' }
```

## Design notes (read this before extending)

- **Args are a single object**, not positional arguments:
  `client.findUser({ id: '123' })`, not `client.findUser('123')`.
- **Endpoints are validated against a fetched package**, not blindly
  dispatched. Calling something the package doesn't declare throws
  immediately (mirrors Ruby's `NoMethodError` / PHP's
  `BadMethodCallException`), rather than silently forwarding an arbitrary
  method name to the server.
- **Name normalization**: an endpoint named `list-items` is callable as
  `client.listItems(...)`, `client.list_items(...)`, or via
  `client.call('list-items', ...)`. Dashes, underscores, and case are all
  folded together for lookup.

## Usage

### Building a client

```js
// Fetches the package by POSTing to the URL as a Web Function endpoint.
const client = await Client.fromPackageEndpoint('https://api.example.com/package');

// Or, if the package is served as plain JSON over GET:
const client = await Client.fromUrl('https://api.example.com/package.json');

// Or, if you already have a package in memory:
import { Package } from 'webfunction-js';
const pkg = Package.fromObject({ base_url: '...', endpoints: [...] });
const client = Client.fromPackage(pkg);
```

All three accept `{ bearerAuth, version }`:

```js
const client = await Client.fromPackageEndpoint(url, {
  bearerAuth: 'my-token',   // sent as `Authorization: Bearer <token>` on every call
  version: '2024-01-01',    // sent as `Api-Version` header (or `api_version` query param via fromUrl)
});
```

### Calling endpoints

```js
await client.listItems({ limit: 10, offset: 20 });

// By raw endpoint name, if you'd rather not rely on method-name lookup:
await client.call('list-items', { limit: 10 });
```

### Pagination

A response shaped like `{ page, next, previous }` is automatically wrapped in
a `Page`:

```js
const page = await client.listPeople({ filters: { firstName: 'Joe' } });

page.page;        // => the current page's items
page.hasNext;      // => true/false
page.hasPrevious;  // => true/false

const next = await page.nextPage(); // posts the opaque `next` cursor back to the same endpoint
```

### Errors

Every failure is a `WfnError` subclass, carrying a `code` and `details`:

```js
import { BadRequestError } from 'webfunction-js';

try {
  await client.findUser({ id: 'missing' });
} catch (err) {
  if (err instanceof BadRequestError) {
    console.error(err.code, err.message, err.details);
    // => "USER_NOT_FOUND" "No user with that id." { id: "missing" }
  }
}
```

| Class | Raised when |
|---|---|
| `BadRequestError` | Server responded with status `400` (body is an `[code, message, details]` error triple, or falls back to a generic code if not) |
| `UnexpectedStatusCodeError` | Server responded with any other non-200 status |
| `JsonParseError` | Response body wasn't valid JSON |
| `UnresolvedPromiseError` | Reserved for pipelining (not implemented — see below) |

### Inspecting a package

```js
const pkg = client.package;

pkg.name;        // "Example API"
pkg.baseUrl;      // "https://api.example.com/"
pkg.versioned;    // true/false
pkg.versions;     // ["2023-06-01", "2024-01-01"]
pkg.endpoints;    // [Endpoint, ...]

const endpoint = pkg.endpoint('find-user');
endpoint.docs;     // "Retrieves user data."
endpoint.group;    // "Users"
endpoint.returns;  // a Type — see below
endpoint.arguments; // [Argument, ...]
endpoint.argument('id').required; // true

const arg = endpoint.argument('id');
arg.type.toString(); // "string"
arg.required;        // true
arg.choices;         // []
```

Named object schemas (referenced as `object.<name>` in types), looked up by
context since the same object can appear in an arguments context or an
attributes context:

```js
const user = pkg.object('user', { context: 'attributes' });
user.attributes; // [Attribute, ...]
```

### Types

`endpoint.returns`, `argument.type`, and `attribute.type` are all `Type`
instances, not plain strings:

```js
const type = endpoint.argument('email').type;

type.toString();       // "string.email"
type.format('base');    // "string"
type.format('compact'); // "email"
type.valid('ada@example.com'); // true
type.valid('nope');            // false
type.objects; // names of any `object.<name>` refs found within the type
```

Base types: `string`, `number`, `object`, `boolean`, `null`, plus `array<T>`
and unions (`A | B`). String refinements: `date`, `time`, `datetime`, `uuid`,
`base64`, `email`, `phone`, `url`, `uri`, `ipv4`, `ipv6`, `hostname`. Number
refinements: `u32`, `u64`, `i32`, `i64`, `f32`, `f64`, `timestamp`.

> Refinement validation (`type.valid(...)`) is a pragmatic best-effort check,
> not a spec-grade validator — good for catching obviously-wrong values, not
> a replacement for server-side validation.

### Custom HTTP client

```js
import { setHttpClient } from 'webfunction-js';

// Receives (url, headers, bodyString); must return [statusCode, rawBodyString].
setHttpClient(async (url, headers, body) => {
  const res = await myHttpLib.post(url, { headers, body });
  return [res.status, res.bodyText];
});
```

Handy for tests — return a canned response without a real request.

## Not implemented yet: pipelining

Ruby's pipelining is more than request batching: under `pipelined: true`,
each call returns a `Promise` standing in for a not-yet-computed value.
Reading a property on that promise *before* it resolves (e.g. `user['id']`)
doesn't give you a value — it gives you a path reference into the future
result, which gets sent to the server as part of the next call in the batch.
The server fills it in when the whole pipeline actually runs.

That's a second, different kind of dynamic-dispatch proxy layered on top of
the one this module already has (one that records property-access paths on
a value that doesn't exist yet), and it deserves its own design pass —
particularly around what "reading into an unresolved value" should feel like
in JS versus Ruby. Flagging it clearly rather than guessing at it.

## Tests

```
node --test
```
