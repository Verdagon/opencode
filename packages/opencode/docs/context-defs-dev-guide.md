# Context-Defs Developer Guide

This guide is for anyone modifying or extending the context-defs feature. It covers the architecture, how to run and write tests, common pitfalls, and how to debug issues.

## Architecture Overview

The feature has three layers:

```
HTTP Route (routes/lsp.ts)
  ├─ Parses unified diff
  ├─ Reads files from disk
  ├─ Applies patches to get before/after content
  ├─ Gets LSP client via opencode's LSP layer
  └─ Calls core analyzeFile()

Core Logic (lsp/context-defs.ts)
  ├─ analyzeFile() — orchestrates before+after analysis
  ├─ analyzeOneSide() — pushes content, gets tokens, resolves definitions
  ├─ enrichDefinitions() — adds definitionText, docComment, endLine to results
  ├─ Pure functions: decodeSemanticTokens, filterInterestingTokens,
  │   extractDocComment, extractDefinitionText, etc.
  └─ Per-document mutex

LSP Client (lsp/client.ts)
  ├─ notify.change() — pushes virtual content without disk read
  ├─ legend getter — semantic token type mapping from server
  └─ connection — raw vscode-jsonrpc MessageConnection
```

### Key files

| File | What it does |
|------|-------------|
| `src/lsp/context-defs.ts` | All core logic. Pure functions + async pipeline. |
| `src/server/routes/lsp.ts` | HTTP route. Diff parsing, file I/O, calls core. |
| `src/lsp/client.ts` | LSP client. We added `notify.change()` and `legend` getter. |
| `src/lsp/index.ts` | LSP namespace. We added `clientsForFile()` export. |
| `src/lsp/language.ts` | File extension → language ID map. Used by `rawConnectionPusher`. |
| `src/server/server.ts` | Server setup. We added `.route("/lsp", LspRoutes())`. |

### Data flow

```
Diff string
  ↓ parseUnifiedDiff()
ParsedFileDiff[] (paths, hunk ranges)
  ↓ read file, applyDiff()
{ originalContent, patchedContent, beforeHunkRanges, afterHunkRanges }
  ↓ analyzeFile()
  ├─ withDocumentLock(filePath, ...)
  ├─ pushContent(filePath, originalContent)     ← didOpen or didChange
  ├─ analyzeOneSide(originalContent, beforeHunkRanges)
  │   ├─ pushContent(filePath, content)         ← didChange
  │   ├─ documentSymbol → findEnclosingDefinitions()
  │   ├─ semanticTokens/full → decodeSemanticTokens()
  │   ├─ filterInterestingTokens() → tokens in scope
  │   └─ resolveTokenDefinitions() → definition locations
  ├─ analyzeOneSide(patchedContent, afterHunkRanges)
  │   └─ (same steps)
  ├─ enrichDefinitions(allDefs)          ← runs inside mutex
  │   ├─ group defs by definedIn.path
  │   ├─ skip defs pointing to analyzed file (virtual content)
  │   ├─ for each target file:
  │   │   ├─ readFileSync()
  │   │   ├─ documentSymbol → find enclosing symbol range
  │   │   ├─ extractDefinitionText() from symbol range
  │   │   └─ extractDocComment() walking backwards from definition
  │   └─ set endLine, endCharacter, definitionText, docComment
  └─ deduplicate union of both sides
SymbolDefinition[]
```

## The ContentPusher Abstraction

The `ContentPusher` type decouples content pushing from the transport:

```typescript
type ContentPusher = (filePath: string, content: string) => Promise<void>
```

Two implementations exist:

1. **`rawConnectionPusher(conn)`** — For tests. Sends `didOpen`/`didChange` directly on a raw `vscode-jsonrpc` connection. Tracks open state internally.

2. **`clientContentPusher(client)`** — For the HTTP route. Uses `client.notify.change()` which coordinates with opencode's own file tracking (`files` map in client.ts).

If you need a new integration path (e.g., calling `analyzeFile` from a tool or MCP server), implement a `ContentPusher` appropriate for your context.

## Test Structure

### Test files

| File | Type | What it tests | Needs RA? | Runtime |
|------|------|--------------|-----------|---------|
| `test/lsp/context-defs.test.ts` | Unit | Pure functions: decode, filter, parse, normalize | No | <1s |
| `test/lsp/context-defs.integration.test.ts` | Integration | Full pipeline against real rust-analyzer | Yes | ~15s |
| `test/lsp/context-defs.perf.test.ts` | Performance | Timing bounds on warm requests | Yes | ~8s |
| `test/server/lsp-context-defs.test.ts` | E2E | HTTP route through Hono app | Partially | ~12s |
| `test/lsp/context-defs.bench.ts` | Benchmark | Standalone perf script (not a test) | Yes | ~15s |

### Test fixture

`test/fixture/sandbox-roguelike/` is a small Rust project (~11 source files) used as test data. It's the "before" state — tests construct "after" content inline by string manipulation.

Key fixture files tests commonly use:
- `src/tile.rs` — small struct, good for simple tests
- `src/game.rs` — larger, has cross-file references, multiple methods
- `src/entity.rs` — largest, has traits, enums, impl blocks, long functions
- `src/location.rs` — cross-file target (many things reference `Location`)

The fixture must compile with rust-analyzer. It has `#![allow(dead_code, unused)]` in `main.rs` to avoid compilation errors from unused code.

### Running tests

```bash
# All context-defs tests
cd packages/opencode
bun test test/lsp/context-defs.test.ts test/lsp/context-defs.integration.test.ts

# Just unit tests (fast, no rust-analyzer needed)
bun test test/lsp/context-defs.test.ts

# Just integration tests
bun test test/lsp/context-defs.integration.test.ts

# Server route tests
bun test test/server/lsp-context-defs.test.ts

# Performance tests
bun test test/lsp/context-defs.perf.test.ts

# Everything
bun test test/lsp/ test/server/lsp-context-defs.test.ts

# Run a single test by name
bun test test/lsp/context-defs.integration.test.ts --grep "91\."

# Standalone benchmark (not a test, prints detailed timing)
bun run test/lsp/context-defs.bench.ts
```

### Integration test setup

The integration tests share a single rust-analyzer instance across all tests in the file. The `beforeAll` hook:

1. Copies the fixture to a temp directory (RA writes build artifacts)
2. Spawns `rust-analyzer` as a child process with stdio pipes
3. Creates a `vscode-jsonrpc` MessageConnection
4. Sends `initialize` with semantic token + hierarchical document symbol capabilities
5. Waits for indexing via `$/progress` notifications
6. Stores `conn` and `legend` for all tests

The `afterAll` hook kills RA and deletes the temp directory.

Individual tests:
1. Read a fixture file
2. Construct modified content via string manipulation
3. Compute hunk ranges (which lines changed)
4. Call `ContextDefs.analyzeFile()` with the raw connection
5. Assert on the returned `SymbolDefinition[]`

### Server route test setup

Server route tests use `Server.Default()` to get the Hono app and `app.request()` to send requests in-process (no actual HTTP server). They set `x-opencode-directory` to point at a temp directory. The `afterEach` hook calls `Instance.disposeAll()` and `resetDatabase()`.

These tests exercise the full stack: route → diff parsing → `LSP.clientsForFile()` → real RA spawn → `analyzeFile()`. They're slower because each test gets a fresh Instance and may trigger a new RA spawn.

## How to Add a New Feature

### Example: Adding a new token type

If a language server uses a custom semantic token type (like rust-analyzer's `"const"` for Rust constants), you need to add it to the filter.

1. **Find the token type name**. Add a test that dumps all tokens for a file and look for unrecognized types:

```typescript
test("debug: dump all token types", async () => {
  const { fileUri } = filePaths("src/entity.rs")
  const text = await fixtureFile("src/entity.rs")
  await conn.sendNotification("textDocument/didOpen", {
    textDocument: { uri: fileUri, languageId: "rust", version: 999, text },
  })
  await new Promise(r => setTimeout(r, 1000))
  const result = await conn.sendRequest("textDocument/semanticTokens/full", {
    textDocument: { uri: fileUri },
  })
  const tokens = ContextDefs.decodeSemanticTokens(result.data, legend)
  const types = new Set(tokens.map(t => t.tokenType))
  console.log("All token types:", [...types].sort())
})
```

2. **Add the type** to `INTERESTING_TOKEN_TYPES` in `context-defs.ts`.

3. **Write a test** that verifies the new type is kept:

```typescript
// In context-defs.test.ts
test("keeps newTokenType", () => {
  expect(ContextDefs.filterInterestingTokens([make("newTokenType")])).toHaveLength(1)
})
```

4. **Write an integration test** that verifies a symbol of that type resolves:

```typescript
// In context-defs.integration.test.ts
test("newTokenType resolves to definition", async () => {
  // Set up file, hunk ranges, call analyzeFile, check result
})
```

### Example: Adding a new LSP request

If you want to add a new LSP operation (e.g., `textDocument/references` to find callers):

1. **Add the method to context-defs.ts** following the pattern of `resolveTokenDefinitions`:

```typescript
export async function findReferences(input: {
  conn: any
  fileUri: string
  line: number
  character: number
}): Promise<Location[]> {
  const result = await input.conn
    .sendRequest("textDocument/references", {
      textDocument: { uri: input.fileUri },
      position: { line: input.line, character: input.character },
      context: { includeDeclaration: false },
    })
    .catch(() => [])
  return normalizeDefinitionResponse(result)
}
```

2. **Write unit tests** with a mock connection:

```typescript
test("findReferences returns locations", async () => {
  const fakeConn = {
    sendRequest: async () => [
      { uri: "file:///foo.rs", range: { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } } },
    ],
  }
  const result = await ContextDefs.findReferences({ conn: fakeConn, fileUri: "file:///bar.rs", line: 5, character: 3 })
  expect(result).toHaveLength(1)
})
```

3. **Write integration tests** using the shared RA connection.

### Example: Supporting a new diff format

If you need to handle a different diff format (e.g., from a patch tool):

1. **Add parsing logic** to `parseUnifiedDiff()` in `context-defs.ts`. The function already handles two formats (`diff --git` and plain `---`/`+++`). Add a new branch.

2. **Write unit tests** in the `parseUnifiedDiff` describe block:

```typescript
test("handles custom diff format", () => {
  const diff = `... your custom format ...`
  const result = ContextDefs.parseUnifiedDiff(diff)
  expect(result).toHaveLength(1)
  expect(result[0].path).toBe("expected/path.rs")
})
```

3. **If the format affects `extractSingleFileDiff`** in `routes/lsp.ts`, update that too and add a server route test.

### Example: Adding a new HTTP endpoint

To expose a new operation (e.g., `POST /lsp/references`):

1. **Add the route** to `src/server/routes/lsp.ts`, following the existing `context-defs` pattern with `describeRoute`, `validator`, `resolver`.

2. **Add server tests** in `test/server/lsp-context-defs.test.ts` using `app.request()`.

## How to Write Tests

### Unit tests (context-defs.test.ts)

For pure functions. No LSP server needed. Fast.

```typescript
test("description", () => {
  const result = ContextDefs.someFunction(input)
  expect(result).toEqual(expected)
})
```

**When to write**: Any new pure function, any change to token filtering, diff parsing, symbol normalization, definition response normalization.

### Integration tests (context-defs.integration.test.ts)

For anything that talks to rust-analyzer. Uses the shared `conn` and `legend` from `beforeAll`.

```typescript
test("description", async () => {
  const { filePath, fileUri } = filePaths("src/somefile.rs")
  const original = await fixtureFile("src/somefile.rs")

  // Construct modified content
  const patched = original.replace("old", "new")

  // Find hunk line ranges
  const origLines = original.split("\n")
  const changeLine = origLines.findIndex(l => l.includes("old"))

  const result = await ContextDefs.analyzeFile({
    conn, legend, filePath, fileUri,
    originalContent: original,
    patchedContent: patched,
    beforeHunkRanges: [{ start: changeLine, end: changeLine + 1 }],
    afterHunkRanges: [{ start: changeLine, end: changeLine + 1 }],
  })

  const symbols = result.map(d => d.symbol)
  expect(symbols).toContain("expectedSymbol")
}, 60_000)  // generous timeout for LSP
```

**When to write**: Any change to `analyzeFile`, `analyzeOneSide`, `resolveTokenDefinitions`, `findEnclosingDefinitions` (with real data), `enrichDefinitions`, or the retry logic.

**Testing enrichment specifically**:
- Cross-file definitions should have non-null `definitionText` and `endLine`
- Same-file definitions (pointing to the analyzed file) should have null enrichment fields
- Namespace symbols at line 0 of a file may have null `definitionText`
- `docComment` depends on actual comments in the fixture files

**Common patterns**:
- Read fixture file, string-replace to create "after" version
- Append new methods/impl blocks for "addition" scenarios
- Use `origLines.findIndex()` to find hunk start lines
- Set `beforeHunkRanges: []` for pure additions (no before-side)
- Use 60_000 timeout for tests that might hit retry delays

### Server route tests (test/server/lsp-context-defs.test.ts)

For the HTTP layer. Uses `Server.Default()` + `app.request()`.

```typescript
test("description", async () => {
  await using tmp = await tmpdir({ git: true })
  // Set up files in tmp.path
  const app = Server.Default()

  try {
    const res = await app.request("/lsp/context-defs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({ diff: "..." }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    // assertions on body
  } finally {
    await Instance.disposeAll()
  }
}, 120_000)
```

**When to write**: Any change to the route handler, diff extraction logic, error handling, or the `clientContentPusher`.

**Important**: Always call `Instance.disposeAll()` in finally block, or the LSP server processes will leak.

### Performance tests (context-defs.perf.test.ts)

For timing bounds. Same setup as integration tests but with assertions on elapsed time.

```typescript
test("operation completes under Nms", async () => {
  // warmup
  await ContextDefs.analyzeFile({ ... })

  const start = Date.now()
  const result = await ContextDefs.analyzeFile({ ... })
  const elapsed = Date.now() - start

  expect(result.length).toBeGreaterThan(0)
  expect(elapsed).toBeLessThan(500)
}, 30_000)
```

**When to write**: After any performance-affecting change (retry logic, parallelization, content pushing).

### What tests to add for a given change

| Change type | Unit test | Integration test | Server test | Perf test |
|-------------|-----------|-----------------|-------------|-----------|
| New pure function | Yes | Maybe | No | No |
| Change token filtering | Yes | Yes (verify tokens resolve) | No | No |
| Change retry/timing logic | No | Yes | Yes | Yes |
| Change diff parsing | Yes | No | Yes (route uses it) | No |
| New LSP request type | Mock test | Yes | Maybe | Maybe |
| Change content pushing | Mock test | Yes | Yes | Yes |
| New route endpoint | No | No | Yes | No |
| Change client.ts | Maybe | Yes | Yes | No |
| Change enrichment logic | Yes (extractDocComment, extractDefinitionText) | Yes (E1-E8 tests) | Yes (verify fields in response) | Maybe |
| Change doc comment rules | Yes (extractDocComment) | Yes | No | No |

## Live Testing

### With rust-analyzer directly

The fastest feedback loop for LSP changes. The benchmark script is good for this:

```bash
bun run test/lsp/context-defs.bench.ts
```

This spawns RA, runs several scenarios, and prints timing + results. Edit the script to add your scenario.

### With opencode serve

For testing the full stack including the HTTP route, Instance management, and opencode's LSP client layer:

```bash
# Terminal 1: start the server
cd /path/to/some/rust/project
opencode serve --port 4096

# Terminal 2: send requests
DIFF=$(git diff HEAD -- src/somefile.rs)
curl -s -X POST http://127.0.0.1:4096/lsp/context-defs \
  -H "Content-Type: application/json" \
  -d "{\"diff\": $(echo "$DIFF" | jq -Rs .)}" | jq .
```

First request will be slow (~3-5s) as RA spawns and indexes. Subsequent requests are fast (~30-100ms).

### Debugging tips

**Empty definitions but no errors**: The LSP server returned tokens but all `textDocument/definition` calls returned `[]`. Usually means:
- RA hasn't finished indexing (retry loop didn't wait long enough)
- The virtual content pushed via `didChange` was overridden by a disk read (check if `workspace/didChangeWatchedFiles` is being sent)
- The token positions don't match the content the server has

**Add temporary logging** to `analyzeOneSide`:
```typescript
console.log("tokens:", tokensResult.data.length / 5)
console.log("enclosing:", enclosingDefs.map(d => `${d.name}@${d.range.start.line}`))
console.log("inScope:", inScope.length)
console.log("defResults sample:", defResults.slice(0, 3))
```

**Check what RA sees** by querying semantic tokens directly:
```typescript
const result = await conn.sendRequest("textDocument/semanticTokens/full", {
  textDocument: { uri: fileUri },
})
const tokens = ContextDefs.decodeSemanticTokens(result.data, legend)
for (const t of tokens) {
  console.log(`L${t.line}:${t.startChar} ${t.tokenType} "${extractSymbolText(t, content)}"`)
}
```

**Check document symbol format** — rust-analyzer returns nested `DocumentSymbol[]` when `hierarchicalDocumentSymbolSupport: true` is advertised, flat `SymbolInformation[]` otherwise. The `normalizeSymbols` function handles both, but if you're debugging, dump the raw response:
```typescript
const symbols = await conn.sendRequest("textDocument/documentSymbol", {
  textDocument: { uri: fileUri },
})
console.log(JSON.stringify(symbols, null, 2).substring(0, 2000))
```

**RA crashes (exit code 101)**: Check stderr for the panic message. Common causes:
- Document version > i32 max (don't use `Date.now()` as version)
- `didOpen` on an already-open document (some RA versions panic, others ignore)
- Proc-macro version mismatch (RA version doesn't match toolchain)

## Common Pitfalls

### LSP document versioning

Version numbers must fit in a signed 32-bit integer. `Date.now()` overflows. Use a counter starting at a small number.

### didOpen vs didChange

`didOpen` on an already-open document is a protocol error. Some servers ignore it, some crash. Always track whether you've opened a file and use `didChange` for subsequent updates. The `rawConnectionPusher` and `client.notify.change()` handle this correctly.

### Semantic token type names are server-specific

The LSP spec defines standard types (`function`, `variable`, `type`, etc.) but servers can add custom ones. rust-analyzer adds `const`, `builtinType`, `selfKeyword`, `lifetime`, `derive`, `procMacro`, `unresolvedReference`, etc. If you're adding support for a new language, you may need to add new types to `INTERESTING_TOKEN_TYPES`.

### SymbolInformation vs DocumentSymbol

`textDocument/documentSymbol` returns one of two formats depending on client capabilities:

- **DocumentSymbol** (nested, with full body ranges) — returned when `hierarchicalDocumentSymbolSupport: true` is in capabilities. This is what we want — the `range` field covers the entire function/struct body.
- **SymbolInformation** (flat, with narrow ranges) — returned otherwise. The `location.range` often only covers the name/signature, not the body. This makes enclosing definition detection unreliable.

Always advertise `hierarchicalDocumentSymbolSupport: true` when creating connections.

### The fixture must compile

rust-analyzer needs the project to compile (or at least parse) for full analysis. If the fixture has compile errors, RA may return incomplete results or crash. The fixture has `#![allow(dead_code, unused)]` to suppress unused-code errors.

If you add files to the fixture, make sure `cargo check` still passes:
```bash
cd test/fixture/sandbox-roguelike && cargo check
```

### Cold start timing

The first request to a project spawns the LSP server and waits for indexing. For rust-analyzer:
- Small crate (~10 files): ~5s
- Medium crate (~100 files): ~15-30s
- Large workspace: minutes

The route uses `waitForServerReady()` (progress-based) on first use. Integration tests use the same mechanism in `beforeAll`. If you're writing a test that creates a new RA connection, you must wait for indexing or definitions will return empty.

### Concurrent file access

The `withDocumentLock` mutex serializes access per file path. Two calls analyzing the same file will run sequentially. Two calls analyzing different files run in parallel. If you add new operations that send `didChange`, they must go through the lock.

### Content pushing and disk state

The `analyzeFile` function pushes virtual content to the LSP server. This means the server's view of the file differs from what's on disk. After analysis, the server retains the last-pushed content. This is fine because:
- opencode's `touchFile` / `notify.open` re-reads from disk on next use
- The next `analyzeFile` call pushes its own content

But if you're debugging and querying the LSP server directly between `analyzeFile` calls, be aware that it may have stale virtual content.

### Enrichment and same-file definitions

The `enrichDefinitions` step runs inside the per-document mutex, after both before/after analysis. It calls `documentSymbol` on **target files** (where definitions are defined) and reads those files from disk to extract `definitionText` and `docComment`.

**Same-file exclusion**: Definitions pointing back to the file being analyzed are skipped. This is because the LSP server has virtual content for that file (from `didChange`), which may differ from what's on disk. If you `readFileSync` that file and try to extract lines at the definition's position, the line numbers won't match because the on-disk file doesn't have the virtual modifications.

**Namespace symbols**: Module-level namespace symbols (e.g., `location` at line 0 of `location.rs`) don't have an enclosing fn/struct/enum in the `documentSymbol` response. The enrichment step won't find a matching symbol, so `definitionText` stays `null`. This is expected.

**Cross-file concurrency**: If two concurrent `analyzeFile` calls analyze different files, and file A's enrichment queries `documentSymbol` on file B while file B's `analyzeFile` is pushing virtual content to B, the enrichment may see B's virtual content instead of the real file. This is a known edge case — unlikely in practice since enrichment targets are typically dependencies, not other files being analyzed in the same diff.

### Doc comment extraction rules

`extractDocComment` walks backwards from the definition start line and collects:
- `///` lines (Rust doc comments)
- `//` lines (regular comments)
- `/** ... */` blocks (block doc comments)
- Blank lines between comments (preserved)

It stops at:
- `/* ... */` non-doc block comments (NOT collected)
- `#[...]` attributes
- Any non-comment, non-blank code line
- The start of the file

If you're adding support for a new language, you may need to adjust these rules (e.g., Python uses `"""docstrings"""`, Java uses `/** ... */` differently).
