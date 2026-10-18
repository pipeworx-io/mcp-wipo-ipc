# @pipeworx/wipo-ipc

International Patent Classification (IPC) lookup — title, validity and
structural breakdown of a classification symbol, the groups/subgroups under
it, and keyword search over classification titles. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1837+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ipc_lookup(symbol, version?)` — one IPC symbol's title (English/French),
  structural breakdown and whether it is currently valid.
- `ipc_children(symbol, version?)` — the symbols classified directly under
  one IPC symbol (main groups under a subclass, subgroups under a group),
  each with a title.
- `ipc_search(query, version?, limit?)` — IPC symbols whose title text
  matches a keyword, e.g. "vaccine".
- `ipc_versions()` — IPC edition dates WIPO currently publishes, naming the
  current (in force) and latest (published, may be future-dated) editions.

## Auth

Keyless. No account, no registration, no rate limit documented.

## Data sources

- World Intellectual Property Organization (WIPO), International Patent
  Classification (IPC) scheme.

## Notes for the next person

- **IPC is not CPC.** The Cooperative Patent Classification (jointly
  maintained by EPO and USPTO) extends IPC with much finer subdivisions, and
  is what EPO/USPTO actually classify most modern patents under. A CPC code
  (e.g. one returned verbatim by `epo-ops` or `epo-publication-server`) is
  not interchangeable with an IPC one even when it looks similar. This pack
  has no CPC awareness at all — Pipeworx has no dedicated CPC lookup pack at
  the time this was written.
- **The catalog's own listed OpenAPI spec for this service is a dead 404** on
  wipo.int. Every operation here was found by reading IPCPUB's own front-end
  JavaScript and probing the resulting candidate paths live — there is no
  published spec to check this against.
- **Symbol format**: humans write "A61K 31/00" or "A01N"; the web service
  itself only accepts a fixed 4-character subclass form ("A01N") or a fixed
  14-character form with the main group zero-padded to 4 digits and the
  subgroup zero-padded to 6 ("A61K" + "0031" + "000000"). `parseSymbol()` is
  the one place that conversion happens — a 1- or 3-character partial symbol
  (just a section, or a class) either 404s or, for a 3-character class-level
  symbol specifically, 500s on the upstream's own validity endpoint; neither
  is attempted here.
- **Title lookup is genuinely slow and occasionally fails for huge
  subclasses — this is upstream, not a bug.** IPCPUB's tree-navigation
  endpoints (`ancestors`/`children`) render a classification's entire nested
  title tree server-side on every request, with no caching: the SAME
  subclass fetch (`A01N`) measured 1.4s once and 20.8s another time. For an
  unusually large subclass — **`A61K` ("medicinal preparations"), one of the
  biggest in the whole scheme** — every key inside it reliably 504s at AWS
  API Gateway's own ~29.5s integration ceiling, with
  `{"message":"Endpoint request timed out"}`, regardless of which specific
  node is queried (the symbol's own key, its immediate group wrapper, or the
  subclass itself). `ipc_lookup` and `ipc_children` both bound this to one
  28-second attempt and degrade to `title_en: null` / `title_fr: null` with
  a plain `title_error` rather than hanging — `valid`/`structure` (from the
  separate, fast, reliable `getvalidity` endpoint) are unaffected either way.
  **A main group under `A61K` — e.g. `A61K 31/00` — is the single symbol
  most likely to hit this**, so don't be surprised if a title request for it
  times out live; that is the upstream's own rendering cost, confirmed by
  repeated direct probes, not a defect in this pack.
- **A made-up but well-formed symbol does not 404 on `getvalidity`** — it
  returns `classification-validity: "N"` (invalid), which `ipc_lookup`
  reports as `valid: false`. A genuinely malformed symbol (wrong section
  letter, missing subclass) is rejected by this pack's own parser before any
  upstream call, as `found: false, reason: "invalid_format"`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "wipo-ipc": {
      "url": "https://gateway.pipeworx.io/wipo-ipc/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/wipo-ipc/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1837+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ipc_lookup \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"A01N 1/00"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ipc_lookup`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "wipo-ipc": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-wipo-ipc"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-wipo-ipc
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Wipo Ipc data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
