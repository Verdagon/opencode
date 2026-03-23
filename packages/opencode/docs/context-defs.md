# Context-Defs API

Given a unified diff, the context-defs endpoint identifies every symbol referenced in the affected code and resolves each to its definition location. This tells you "what does this change depend on?" — every function called, type referenced, field accessed, constant used, etc., along with the exact file and line where each is defined.

## Endpoint

```
POST /lsp/context-defs
```

Available on `opencode serve`.

## Request

```json
{
  "diff": "<unified diff string>"
}
```

The diff can be in either format:
- **git format**: `diff --git a/src/foo.rs b/src/foo.rs` (from `git diff`)
- **plain format**: `--- a/src/foo.rs` / `+++ b/src/foo.rs` (from `diff` command or `createTwoFilesPatch`)

Multi-file diffs are supported — each file is analyzed independently.

The `x-opencode-directory` header (or `?directory=` query param) sets the project root. Files referenced in the diff are resolved relative to this root.

## Response

```json
{
  "definitions": [
    {
      "symbol": "Location",
      "tokenType": "struct",
      "definedIn": {
        "path": "/absolute/path/to/src/location.rs",
        "line": 3,
        "character": 11,
        "endLine": 7,
        "endCharacter": 1
      },
      "usedAt": {
        "path": "/absolute/path/to/src/tile.rs",
        "line": 14,
        "character": 39
      },
      "definitionText": "#[derive(new, Copy, Clone, Hash, Eq, PartialEq, Debug)]\npub struct Location {\n    pub x: i32,\n    pub y: i32,\n}",
      "docComment": null
    }
  ],
  "errors": []
}
```

### Fields

**`definitions`** — Array of resolved symbol definitions:

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | The symbol name as it appears in code (e.g., `"Location"`, `"get_player"`, `"entities"`) |
| `tokenType` | string | LSP semantic token type (e.g., `"struct"`, `"method"`, `"property"`, `"function"`, `"namespace"`, `"const"`, `"enum"`, `"variable"`, `"parameter"`, `"macro"`) |
| `definedIn.path` | string | Absolute path to the file where the symbol is defined |
| `definedIn.line` | number | 0-based line number of the definition start |
| `definedIn.character` | number | 0-based character offset of the definition start |
| `definedIn.endLine` | number or null | 0-based line number of the definition end. `null` if the definition is in the same file being analyzed (virtual content) or if the enclosing symbol couldn't be found. |
| `definedIn.endCharacter` | number or null | 0-based character offset of the definition end |
| `usedAt.path` | string | Absolute path to the file where the symbol is referenced (from the diff) |
| `usedAt.line` | number | 0-based line number of the reference |
| `usedAt.character` | number | 0-based character offset of the reference |
| `definitionText` | string or null | Full source text of the enclosing definition (function body, struct, enum, trait). Includes the signature, body, and closing brace. `null` for same-file definitions (virtual content), namespace/module symbols, or if the source file couldn't be read. |
| `docComment` | string or null | Comments directly above the definition. Collects `///`, `//`, and `/** */` doc block comments. Does NOT collect `/* */` non-doc block comments. Stops at attributes (`#[...]`), code lines, or the start of the file. `null` if no comments exist above the definition. |

**`errors`** — Array of error strings for files that couldn't be analyzed (e.g., file not found, no LSP server for the language, diff couldn't be applied).

### Enrichment details

After resolving definition locations, the endpoint **enriches** each definition with full text and doc comments by:

1. Reading the definition's source file from disk
2. Calling `documentSymbol` on that file to find the enclosing symbol's full range
3. Extracting the definition text from the symbol's range
4. Walking backwards from the definition start to collect doc comments

**Same-file definitions** (where `definedIn.path` equals the file being analyzed) are NOT enriched because they reference virtual content that may differ from what's on disk. Their `definitionText`, `docComment`, `endLine`, and `endCharacter` will be `null`.

**Namespace symbols** (e.g., `location` pointing to line 0 of `location.rs`) represent the module itself, not a definition body. These typically have `null` for `definitionText`.

**External crate and stdlib definitions** ARE enriched when the source is available on disk (which it usually is — in `~/.cargo/registry/` and `~/.rustup/toolchains/` respectively).

### What gets scanned

The endpoint analyzes **both the before and after versions** of the code. For each hunk in the diff, it finds the **enclosing definition** (function, struct, trait, or enum) and scans all symbols within that entire definition body — not just the changed lines.

This means if you change one line in a 50-line function, you get definitions for every symbol referenced anywhere in that function. Symbols from the before-version that were removed in the after-version are also included (union of both sides).

### What's included

- **Project symbols**: functions, structs, enums, traits, methods, fields, constants defined in the project
- **Standard library**: `String`, `Vec`, `Option`, `format!`, etc. — paths point to the rustup toolchain source
- **External crate types**: `generational_arena::Index`, etc. — paths point to `~/.cargo/registry/...`
- **Macro-generated items**: `#[derive(new)]` generated constructors, etc.

Definitions are deduplicated — if `Location` is referenced 5 times in the same function, it appears once.

### What's excluded

- **Keywords**: `fn`, `let`, `pub`, `impl`, `match`, etc.
- **Operators**: `+`, `==`, `&&`, etc.
- **Literals**: strings, numbers, booleans
- **Comments**
- **`self`** references
- **Lifetimes**: `'a`, `'static`
- **Built-in types**: `i32`, `bool`, `usize` (tagged as `builtinType` by rust-analyzer)
- **Symbols outside the enclosing definition**: if a diff only touches `fn foo()`, symbols in `fn bar()` are not included even if they're in the same file

## Performance

| Scenario | Cold (first request, LSP spawning) | Warm |
|----------|------|------|
| Small change (1 line, 1 method) | ~3s | ~30ms |
| New method with cross-file refs | ~3s | ~2ms |
| Large method (150 lines, ~100 symbols) | ~3s | ~70ms |
| 3 files in parallel | ~3s | ~30ms |

Cold start includes the LSP server spawning and indexing the project (~5s for a small Rust crate). Subsequent requests reuse the running server.

## Usage from Guardian

### Step 1: Start opencode serve

```bash
cd /path/to/target-project
opencode serve --port 4096
```

Or from Guardian's Rust code, spawn the process:

```rust
let mut child = Command::new("opencode")
    .args(&["serve", "--port", "4096"])
    .current_dir(&project_dir)
    .spawn()?;
```

### Step 2: Generate a diff

Guardian already has the diff from `git diff`. Use it directly:

```rust
let diff = run_git(&["diff", "HEAD"], &repo_dir)?;
```

Or for a specific definition's file:

```rust
let diff = run_git(&["diff", "HEAD", "--", &file_path], &repo_dir)?;
```

### Step 3: Call the endpoint

```rust
let client = reqwest::Client::new();
let response = client
    .post("http://127.0.0.1:4096/lsp/context-defs")
    .header("Content-Type", "application/json")
    .header("x-opencode-directory", &project_dir)
    .json(&serde_json::json!({ "diff": diff }))
    .send()
    .await?;

let result: ContextDefsResult = response.json().await?;
```

With the response types:

```rust
#[derive(Deserialize)]
struct ContextDefsResult {
    definitions: Vec<SymbolDefinition>,
    errors: Vec<String>,
}

#[derive(Deserialize)]
struct SymbolDefinition {
    symbol: String,
    #[serde(rename = "tokenType")]
    token_type: String,
    #[serde(rename = "definedIn")]
    defined_in: DefinedInLocation,
    #[serde(rename = "usedAt")]
    used_at: UsedAtLocation,
    #[serde(rename = "definitionText")]
    definition_text: Option<String>,
    #[serde(rename = "docComment")]
    doc_comment: Option<String>,
}

#[derive(Deserialize)]
struct DefinedInLocation {
    path: String,
    line: u32,
    character: u32,
    #[serde(rename = "endLine")]
    end_line: Option<u32>,
    #[serde(rename = "endCharacter")]
    end_character: Option<u32>,
}

#[derive(Deserialize)]
struct UsedAtLocation {
    path: String,
    line: u32,
    character: u32,
}
```

### Step 4: Use the definitions for context

For each changed definition Guardian validates, the context-defs response tells you what it depends on. The response includes the full source text of each referenced definition — no need to read files yourself.

**Use `definitionText` directly (preferred — no file I/O needed):**

```rust
for def in &result.definitions {
    // Skip stdlib and external crate definitions
    if def.defined_in.path.contains(".cargo/registry")
        || def.defined_in.path.contains(".rustup/toolchains") {
        continue;
    }

    if let Some(text) = &def.definition_text {
        let header = if let Some(doc) = &def.doc_comment {
            format!("{}\n", doc)
        } else {
            String::new()
        };

        context.push(format!(
            "// Referenced {} '{}' from {}:{}\n{}{}",
            def.token_type, def.symbol,
            def.defined_in.path, def.defined_in.line + 1,
            header, text,
        ));
    }
}
```

**Filter by token type to focus on what matters:**

```rust
// Only function/method signatures the changed code calls
let called_fns: Vec<_> = result.definitions.iter()
    .filter(|d| d.token_type == "function" || d.token_type == "method")
    .filter(|d| !d.defined_in.path.contains(".cargo"))
    .collect();

// Only types/structs referenced
let referenced_types: Vec<_> = result.definitions.iter()
    .filter(|d| d.token_type == "struct" || d.token_type == "enum" || d.token_type == "type")
    .collect();

// Only fields accessed
let accessed_fields: Vec<_> = result.definitions.iter()
    .filter(|d| d.token_type == "property")
    .collect();
```

**Distinguish project vs external definitions:**

```rust
fn is_project_def(def: &SymbolDefinition, project_root: &str) -> bool {
    def.defined_in.path.starts_with(project_root)
}

fn is_stdlib_def(def: &SymbolDefinition) -> bool {
    def.defined_in.path.contains(".rustup/toolchains")
}

fn is_external_crate_def(def: &SymbolDefinition) -> bool {
    def.defined_in.path.contains(".cargo/registry")
}
```

### Step 5: Integration with Guardian's validation flow

In Guardian's `validate_definition()` flow, after building the contextified diff:

```
1. git diff → changed files
2. find_changed_definitions() → list of changed definitions
3. build_contextified_diff_for_def() → diff with surrounding code context
4. [NEW] POST /lsp/context-defs with the file's diff
    → get all symbols the changed definition depends on
5. Read source snippets of project-internal definitions
6. Add to LLM prompt:
    "The changed code references these definitions:"
    + source snippets of called functions, used types, accessed fields
7. LLM validates the change with full dependency context
```

### Example: curl

```bash
# Start the server
opencode serve --port 4096 &

# Generate a diff
DIFF=$(cd /path/to/project && git diff HEAD -- src/tile.rs)

# Call the endpoint
curl -s -X POST http://127.0.0.1:4096/lsp/context-defs \
  -H "Content-Type: application/json" \
  -H "x-opencode-directory: /path/to/project" \
  -d "{\"diff\": $(echo "$DIFF" | jq -Rs .)}" | jq .
```

Example response:

```json
{
  "definitions": [
    {
      "symbol": "walkable",
      "tokenType": "property",
      "definedIn": {
        "path": "/path/to/project/src/tile.rs",
        "line": 2,
        "character": 8,
        "endLine": null,
        "endCharacter": null
      },
      "usedAt": {
        "path": "/path/to/project/src/tile.rs",
        "line": 11,
        "character": 13
      },
      "definitionText": null,
      "docComment": null
    },
    {
      "symbol": "Location",
      "tokenType": "struct",
      "definedIn": {
        "path": "/path/to/project/src/location.rs",
        "line": 3,
        "character": 11,
        "endLine": 6,
        "endCharacter": 1
      },
      "usedAt": {
        "path": "/path/to/project/src/tile.rs",
        "line": 14,
        "character": 39
      },
      "definitionText": "#[derive(new, Copy, Clone, Hash, Eq, PartialEq, Debug)]\npub struct Location {\n    pub x: i32,\n    pub y: i32,\n}",
      "docComment": null
    },
    {
      "symbol": "String",
      "tokenType": "struct",
      "definedIn": {
        "path": "/Users/you/.rustup/toolchains/.../src/string.rs",
        "line": 352,
        "character": 11,
        "endLine": 365,
        "endCharacter": 1
      },
      "usedAt": {
        "path": "/path/to/project/src/tile.rs",
        "line": 6,
        "character": 24
      },
      "definitionText": "pub struct String {\n    vec: Vec<u8>,\n}",
      "docComment": "/// A UTF-8–encoded, growable string.\n///\n/// The `String` type is the most common string type..."
    }
  ],
  "errors": []
}
```

Note in the example above:
- `walkable` has `null` for `definitionText` and `endLine` because it's in the same file being analyzed (virtual content)
- `Location` has full `definitionText` with the struct body, enriched from the on-disk source
- `String` has `definitionText` and `docComment` enriched from the stdlib source on disk
```

## Supported Languages

The endpoint works with any language that has an LSP server configured in opencode. Out of the box:

- **Rust** (rust-analyzer) — tested extensively
- **TypeScript/JavaScript** (typescript-language-server)
- **Python** (pyright)
- **Go** (gopls)
- **C/C++** (clangd)
- **And 30+ more** — see opencode's LSP server definitions

The LSP server is spawned automatically on first request for a given language/project. Subsequent requests reuse the running server.

## Error Handling

The endpoint never returns HTTP errors for analysis failures — it always returns 200 with partial results. Per-file errors appear in the `errors` array:

| Error | Meaning |
|-------|---------|
| `"src/foo.rs: file not found"` | Diff references a file that doesn't exist on disk |
| `"src/foo.rs: no LSP server available"` | No LSP server configured for this file's language |
| `"src/foo.rs: LSP server does not support semantic tokens"` | LSP server doesn't support the semantic tokens protocol |
| `"src/foo.rs: could not apply diff"` | Diff context doesn't match the file on disk |

HTTP 400 is returned only for malformed requests (missing `diff` field).

## Limitations

1. **Assumes disk = before-state**: The endpoint reads the file from disk and applies the diff forward to get the after-state. If the file on disk has already been modified (is the after-state), the diff will fail to apply.

2. **Cold start latency**: First request for a language/project pays the LSP server startup + indexing cost (2-10s depending on project size).

3. **Single connection per server**: The per-document mutex prevents concurrent analysis of the same file, but different files can be analyzed in parallel.

4. **Macro-generated definitions**: Symbols from proc macros (e.g., `#[derive(new)]`) may show as `unresolvedReference` and fail to resolve to a definition.

5. **Same-file definitions not enriched**: Definitions pointing back to the file being analyzed have `null` for `definitionText`, `docComment`, `endLine`, and `endCharacter`. This is because the LSP server has virtual content for that file (from `didChange`), which may differ from what's on disk. Cross-file definitions are always enriched from the real on-disk source.

6. **Namespace symbols not enriched**: Module-level namespace symbols (e.g., `location` pointing to line 0 of `location.rs`) represent the module itself, not a definition body. These have `null` for `definitionText`.

7. **Doc comment collection rules**: Only `///`, `//`, and `/** */` comments are collected. `/* */` non-doc block comments are excluded. Attributes (`#[...]`) between a comment and the definition break the comment chain — the comment is not collected.
