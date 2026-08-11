# webfunction-js

JS client for the [Web Function](https://webfunction.org) protocol, modeled
on [Robin Clart's Ruby gem](https://github.com/robinclart/web_function).

A Web Function API publishes a **package**: a JSON document listing its
endpoints, their arguments, return types, and docs. This library reads a
package and turns each endpoint into an ordinary-looking method call.

```js
import { Client } from 'webfunction'

const client = await Client.fromPackageEndpoint('https://api.example.com/package')

await client.findUser({ id: '123' })
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
const client = await Client.fromPackageEndpoint('https://api.example.com/package')

// Or, if the package is served as plain JSON over GET:
const client = await Client.fromUrl('https://api.example.com/package.json')

// Or, if you already have a package in memory:
import { Package } from 'webfunction'
const pkg = Package.fromObject({ base_url: '...', endpoints: [...] })
const client = Client.fromPackage(pkg)
```

All three accept `{ bearerAuth, version }`:

```js
const client = await Client.fromPackageEndpoint(url, {
  bearerAuth: 'my-token',   // sent as `Authorization: Bearer <token>` on every call
  version: '2024-01-01',    // sent as `Api-Version` header (or `api_version` query param via fromUrl)
})
```

### Calling endpoints

```js
await client.listItems({ limit: 10, offset: 20 })

// By raw endpoint name, if you'd rather not rely on method-name lookup:
await client.call('list-items', { limit: 10 })
```

### Pagination

A response shaped like `{ page, next, previous }` is automatically wrapped in
a `Page`:

```js
const page = await client.listPeople({ filters: { firstName: 'Joe' } })

page.page         // => the current page's items
page.hasNext      // => true/false
page.hasPrevious  // => true/false

const next = await page.nextPage() // posts the opaque `next` cursor back to the same endpoint
```

### Errors

Every failure is a `WfnError` subclass, carrying a `code` and `details`:

```js
import { BadRequestError } from 'webfunction'

try {
  await client.findUser({ id: 'missing' })
} catch (err) {
  if (err instanceof BadRequestError) {
    console.error(err.code, err.message, err.details)
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
const pkg = client.package

pkg.name        // "Example API"
pkg.baseUrl      // "https://api.example.com/"
pkg.versioned    // true/false
pkg.versions     // ["2023-06-01", "2024-01-01"]
pkg.supportsPipelining // true/false
pkg.pipelineUrl  // "https://api.example.com/pipeline", or null
pkg.endpoints    // [Endpoint, ...]

const endpoint = pkg.endpoint('find-user')
endpoint.docs     // "Retrieves user data."
endpoint.group    // "Users"
endpoint.returns  // a Type — see below
endpoint.arguments // [Argument, ...]
endpoint.argument('id').required // true

const arg = endpoint.argument('id')
arg.type.toString() // "string"
arg.required        // true
arg.choices         // []
```

Named object schemas (referenced as `object.<name>` in types), looked up by
context since the same object can appear in an arguments context or an
attributes context:

```js
const user = pkg.object('user', { context: 'attributes' })
user.attributes // [Attribute, ...]
```

### Types

`endpoint.returns`, `argument.type`, and `attribute.type` are all `Type`
instances, not plain strings:

```js
const type = endpoint.argument('email').type

type.toString()       // "string.email"
type.format('base')    // "string"
type.format('compact') // "email"
type.valid('ada@example.com') // true
type.valid('nope')            // false
type.objects // names of any `object.<name>` refs found within the type
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
import { setHttpClient } from 'webfunction'

// Receives (url, headers, bodyString); must return [statusCode, rawBodyString].
setHttpClient(async (url, headers, body) => {
  const res = await myHttpLib.post(url, { headers, body })
  return [res.status, res.bodyText]
})
```

Handy for tests — return a canned response without a real request.

## Pipelining

A package signals pipelining support by declaring `pipeline_url`
(webfunction.org/pipelining, "Discovery"). Build a pipelined client the same
way as any other, and calls queue instead of executing immediately:

```js
const client = await Client.fromPackageEndpoint(url, { pipelined: true })

const user  = client.findUser({ id: '123' })          // queued, not sent yet
const order = client.createOrder({ userId: user.id }) // references user's future "id"

const result = await order.resolve() // sends both steps in ONE request
// => { id: 'order-1', userId: '123' }

user.value // already filled in too — resolving one promise runs the whole batch
```

`user.id` here doesn't give a value — it gives a `Path` reference
(`"$[0].id"`) that gets sent as-is in `order`'s request body; the server
substitutes the real value when it executes step 0.

A couple of things worth knowing:

- **`client.pipelined` can be toggled after construction**, in either
  direction, safely: turning it on lazily creates (or reuses) the
  underlying `Pipeline` — it throws if the package has no `pipeline_url`.
  Turning it off is refused while that `Pipeline` still has unresolved
  queued steps, so a toggle can't silently strand them; resolve or execute
  first.
- **Not a real JS `Promise`.** Nothing runs until you call `.resolve()` (or
  `client.pipeline.execute()` directly) — there's no background execution,
  and `await`-ing an unresolved one just gives the object back rather than
  hanging (it's explicitly not treated as thenable).
- **Only the top-level value a call returns supports `.resolve()`/`.value`.**
  Calling those on a nested field reference (`user.id.resolve()`) throws
  clearly rather than silently building a wrong path.
- **Literal argument strings starting with `$` are escaped automatically.**
  `client.findUser({ id: '$100' })` sends `"\$100"`, so the server reads it
  as the literal string `$100` rather than a broken JSONPath reference
  (webfunction.org/pipelining, "Escaping"). This only applies to real
  string values you pass in — a `Path`/`PipelinePromise` reference like
  `user.id` is left untouched, since that's a genuine reference.
- Building steps by hand instead of through the endpoint sugar? `Pipeline`,
  `PipelinePromise`, `Path`, and `escapeForPipeline` are all exported
  directly:

  ```js
  import { Pipeline, escapeForPipeline } from 'webfunction'

  const pipeline = new Pipeline('https://api.example.com/run-pipeline')
  const user = pipeline.addStep({
    url: 'https://api.example.com/find-user',
    headers: {},
    body: escapeForPipeline({ id: '123' }),
  })
  ```

- `pipeline.execute({ returns })` accepts `'all'` (default — fills every
  promise), `'last'` (fills only the last), or a JSONPath string (returns the
  server's evaluation of that expression directly; fills no promises,
  matching the Ruby gem).

## Tests

```
node --test
```