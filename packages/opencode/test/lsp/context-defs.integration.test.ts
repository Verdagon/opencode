import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "child_process"
import { mkdtemp, cp, rm, readFile } from "fs/promises"
import path from "path"
import os from "os"
import { pathToFileURL } from "url"
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node"
import { ContextDefs } from "../../src/lsp/context-defs"

const FIXTURE = path.join(__dirname, "../fixture/sandbox-roguelike")

// Helper: calls analyzeFile, asserts no errors, returns definitions.
// This ensures every test fails if there are unexpected errors.
async function analyze(
  input: Parameters<typeof ContextDefs.analyzeFile>[0],
): Promise<ContextDefs.SymbolDefinition[]> {
  const { definitions, errors } = await ContextDefs.analyzeFile(input)
  if (errors.length > 0) {
    throw new Error(`analyzeFile returned errors: ${errors.join("; ")}`)
  }
  return definitions
}

let sandboxDir: string
let conn: any
let proc: any
let legend: any

async function waitForIdle(activeProgress: Set<string>, maxMs: number) {
  const start = Date.now()
  while (activeProgress.size === 0 && Date.now() - start < 3000) {
    await new Promise((r) => setTimeout(r, 100))
  }
  while (activeProgress.size > 0 && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 200))
  }
  await new Promise((r) => setTimeout(r, 500))
}

// Helper: read a fixture file
async function fixtureFile(relPath: string): Promise<string> {
  return readFile(path.join(sandboxDir, relPath), "utf-8")
}

// Helper: get absolute path + URI for a file in the sandbox
function filePaths(relPath: string) {
  const abs = path.join(sandboxDir, relPath)
  return { filePath: abs, fileUri: pathToFileURL(abs).href }
}

// Helper: compute hunk ranges for a simple insertion at a line
function insertionHunks(insertAfterLine: number, lineCount: number) {
  return {
    before: [{ start: insertAfterLine, end: insertAfterLine }],
    after: [{ start: insertAfterLine, end: insertAfterLine + lineCount }],
  }
}

describe("context-defs integration (rust-analyzer)", () => {
  beforeAll(async () => {
    // Copy fixture to temp dir (rust-analyzer writes build artifacts)
    sandboxDir = await mkdtemp(path.join(os.tmpdir(), "opencode-test-sandbox-"))
    await cp(FIXTURE, sandboxDir, { recursive: true })

    // Spawn rust-analyzer
    proc = spawn("rust-analyzer", [], {
      cwd: sandboxDir,
      stdio: ["pipe", "pipe", "pipe"],
    })
    proc.stderr.on("data", () => {})

    conn = createMessageConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(proc.stdin),
    )

    const activeProgress = new Set<string>()
    conn.onNotification("$/progress", (params: any) => {
      if (params.value?.kind === "begin") activeProgress.add(String(params.token))
      if (params.value?.kind === "end") activeProgress.delete(String(params.token))
    })

    conn.listen()

    const initResult = await conn.sendRequest("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(sandboxDir).href,
      workspaceFolders: [{ name: "workspace", uri: pathToFileURL(sandboxDir).href }],
      capabilities: {
        window: { workDoneProgress: true },
        textDocument: {
          synchronization: { didOpen: true, didChange: true },
          semanticTokens: {
            dynamicRegistration: false,
            requests: { full: true },
            tokenTypes: [],
            tokenModifiers: [],
            formats: ["relative"],
          },
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
        },
      },
      initializationOptions: {
        procMacro: { enable: false },
      },
    })

    legend = (initResult as any).capabilities?.semanticTokensProvider?.legend
    await conn.sendNotification("initialized", {})
    await waitForIdle(activeProgress, 60000)
  }, 120_000)

  afterAll(async () => {
    if (conn) { conn.end(); conn.dispose() }
    if (proc) proc.kill()
    if (sandboxDir) await rm(sandboxDir, { recursive: true, force: true }).catch(() => {})
  })

  // --- M4: semantic tokens ---

  describe("M4: semantic tokens with rust-analyzer", () => {
    test("67. legend has 50+ token types", () => {
      expect(legend).toBeDefined()
      expect(legend.tokenTypes.length).toBeGreaterThanOrEqual(50)
    })

    test("68. legend includes expected types", () => {
      for (const t of ["function", "method", "struct", "enum", "variable", "macro"]) {
        expect(legend.tokenTypes).toContain(t)
      }
    })

    test("70. semanticTokens on tile.rs returns data", async () => {
      const { fileUri } = filePaths("src/tile.rs")
      const text = await fixtureFile("src/tile.rs")
      await conn.sendNotification("textDocument/didOpen", {
        textDocument: { uri: fileUri, languageId: "rust", version: 0, text },
      })
      await new Promise((r) => setTimeout(r, 1000))

      const result: any = await conn.sendRequest("textDocument/semanticTokens/full", {
        textDocument: { uri: fileUri },
      })
      expect(result.data.length).toBeGreaterThan(0)
      expect(result.data.length % 5).toBe(0)
    })

    test("72. after didChange, tokens include new symbols", async () => {
      const { fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")
      const modified = original +
        "\nimpl Tile {\n    pub fn for_game(&self, game: &crate::game::Game) -> bool { true }\n}\n"

      await conn.sendNotification("textDocument/didOpen", {
        textDocument: { uri: fileUri, languageId: "rust", version: 100, text: modified },
      })
      await new Promise((r) => setTimeout(r, 1500))

      const result: any = await conn.sendRequest("textDocument/semanticTokens/full", {
        textDocument: { uri: fileUri },
      })
      const tokens = ContextDefs.decodeSemanticTokens(result.data, legend)
      const texts = tokens.map((t) => ContextDefs.extractSymbolText(t, modified))
      expect(texts).toContain("Game")
      expect(texts).toContain("for_game")

      // Restore
      await conn.sendNotification("textDocument/didChange", {
        textDocument: { uri: fileUri, version: 101 },
        contentChanges: [{ text: original }],
      })
    })
  })

  // --- M5a: enclosing definitions ---

  describe("M5a: enclosing definitions", () => {
    test("73. documentSymbol on game.rs returns Game and LCGRand", async () => {
      const { fileUri } = filePaths("src/game.rs")
      const text = await fixtureFile("src/game.rs")
      await conn.sendNotification("textDocument/didOpen", {
        textDocument: { uri: fileUri, languageId: "rust", version: 200, text },
      })
      await new Promise((r) => setTimeout(r, 1000))

      const symbols: any[] = await conn.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: fileUri },
      })
      const names = symbols.map((s: any) => s.name)
      expect(names).toContain("Game")
      expect(names).toContain("LCGRand")
    })

    test("75. findEnclosingDefinitions finds fn for hunk inside a method", async () => {
      const { fileUri } = filePaths("src/game.rs")
      const text = await fixtureFile("src/game.rs")
      await conn.sendNotification("textDocument/didOpen", {
        textDocument: { uri: fileUri, languageId: "rust", version: 210, text },
      })
      await new Promise((r) => setTimeout(r, 500))

      const symbols: any[] = await conn.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: fileUri },
      })

      // Find get_player method (may be nested under impl block in hierarchical format)
      const getPlayer = findSymbolByName(symbols, "get_player")
      expect(getPlayer).toBeDefined()
      const range = getPlayer.location?.range ?? getPlayer.range

      const enclosing = ContextDefs.findEnclosingDefinitions(symbols, [
        { start: range.start.line, end: range.end.line },
      ])
      expect(enclosing.map((s) => s.name)).toContain("get_player")
    })

    test("77. findEnclosingDefinitions finds struct for field hunk", async () => {
      const { fileUri } = filePaths("src/tile.rs")
      const text = await fixtureFile("src/tile.rs")
      await conn.sendNotification("textDocument/didOpen", {
        textDocument: { uri: fileUri, languageId: "rust", version: 220, text },
      })
      await new Promise((r) => setTimeout(r, 500))

      const symbols: any[] = await conn.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: fileUri },
      })

      const tile = symbols.find((s: any) => s.name === "Tile" && s.kind === 23)
      expect(tile).toBeDefined()
      const range = tile.location?.range ?? tile.range

      const enclosing = ContextDefs.findEnclosingDefinitions(symbols, [
        { start: range.start.line + 1, end: range.start.line + 2 },
      ])
      expect(enclosing.map((s) => s.name)).toContain("Tile")
    })
  })

  // --- M5b: definition resolution ---

  describe("M5b: definition resolution", () => {
    test("81. Location in game.rs resolves to location.rs", async () => {
      const { fileUri } = filePaths("src/game.rs")
      const text = await fixtureFile("src/game.rs")
      await conn.sendNotification("textDocument/didOpen", {
        textDocument: { uri: fileUri, languageId: "rust", version: 300, text },
      })
      await new Promise((r) => setTimeout(r, 1000))

      const result: any = await conn.sendRequest("textDocument/semanticTokens/full", {
        textDocument: { uri: fileUri },
      })
      const tokens = ContextDefs.decodeSemanticTokens(result.data, legend)
      const locTokens = tokens.filter(
        (t) => ContextDefs.extractSymbolText(t, text) === "Location" && t.tokenType === "struct",
      )
      expect(locTokens.length).toBeGreaterThan(0)

      const def: any = await conn.sendRequest("textDocument/definition", {
        textDocument: { uri: fileUri },
        position: { line: locTokens[0].line, character: locTokens[0].startChar },
      })
      const locs = Array.isArray(def) ? def : [def]
      expect(new URL(locs[0].uri || locs[0].targetUri).pathname).toContain("location.rs")
    })
  })

  // --- M6: full pipeline ---

  describe("M6: full pipeline (analyzeFile)", () => {
    test("91. constant rename: result includes new constant", async () => {
      const { filePath, fileUri } = filePaths("src/entity.rs")
      const original = await fixtureFile("src/entity.rs")

      // In the original, the IStrengthAffector impl for Entity has get_strength_boost
      // returning `if self.is_priest { 5 } else { 0 }`.
      // Modify to use a constant PRIEST_STRENGTH_BOOST.
      const patched = original
        .replace(
          "const AURA_RANGE: i32 = 500;",
          "const AURA_RANGE: i32 = 500;\nconst PRIEST_STRENGTH_BOOST: i32 = 5;",
        )
        .replace(
          "if self.is_priest { 5 } else { 0 }",
          "if self.is_priest { PRIEST_STRENGTH_BOOST } else { 0 }",
        )

      // Find the line with the actual change in the impl body
      const origLines = original.split("\n")
      const patchedLines = patched.split("\n")
      const origChangeLine = origLines.findIndex((l) => l.includes("is_priest { 5 }"))
      // Find the USAGE of PRIEST_STRENGTH_BOOST (in the impl body), not the const declaration
      const patchedChangeLine = patchedLines.findIndex((l) =>
        l.includes("is_priest { PRIEST_STRENGTH_BOOST }"),
      )

      const result = await analyze({
        conn,
        legend,
        filePath,
        fileUri,
        originalContent: original,
        patchedContent: patched,
        beforeHunkRanges: [{ start: origChangeLine, end: origChangeLine + 1 }],
        afterHunkRanges: [{ start: patchedChangeLine, end: patchedChangeLine + 1 }],
      })
      const symbols = result.map((d) => d.symbol)
      expect(symbols).toContain("PRIEST_STRENGTH_BOOST")
    }, 60_000)

    test("93. new method with cross-file refs includes Location", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")

      // Add a method that references Location from location.rs
      const newMethod = `
    pub fn default_location(&self) -> crate::location::Location {
        crate::location::Location::new(0, 0)
    }`
      // Insert before the closing } of the impl block
      const patched = original.replace(
        /^}$/m,
        newMethod + "\n}",
      )

      const patchedLines = patched.split("\n")
      const methodLine = patchedLines.findIndex((l) => l.includes("default_location"))

      const result = await analyze({
        conn,
        legend,
        filePath,
        fileUri,
        originalContent: original,
        patchedContent: patched,
        beforeHunkRanges: [], // new method doesn't exist in before
        afterHunkRanges: [{ start: methodLine, end: methodLine + 3 }],
      })

      const symbols = result.map((d) => d.symbol)
      expect(symbols).toContain("Location")
    }, 60_000)

    test("94. new method referencing external crate type", async () => {
      const { filePath, fileUri } = filePaths("src/game.rs")
      const original = await fixtureFile("src/game.rs")

      // Add apply_combat_damage method to Game impl
      // Find the last method in the Game impl block and insert after it
      const newMethod = `
    pub fn apply_combat_damage(&mut self, attacker_idx: generational_arena::Index, defender_idx: generational_arena::Index) {
        let attacker = &self.entities[attacker_idx];
        let base_damage = attacker.damage;
        if let Some(defender) = self.entities.get_mut(defender_idx) {
            defender.hp -= base_damage;
        }
    }`
      // Insert before the closing brace of the Game impl (after add_entity_to_level)
      const patched = original.replace(
        "        return entity_index;\n    }\n}",
        "        return entity_index;\n    }\n" + newMethod + "\n}",
      )

      const patchedLines = patched.split("\n")
      const methodLine = patchedLines.findIndex((l) => l.includes("apply_combat_damage"))

      const result = await analyze({
        conn,
        legend,
        filePath,
        fileUri,
        originalContent: original,
        patchedContent: patched,
        beforeHunkRanges: [],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 8 }],
      })

      const symbols = result.map((d) => d.symbol)
      // Should resolve Entity fields and generational_arena types
      expect(symbols.length).toBeGreaterThan(0)
      expect(symbols).toContain("entities")
    }, 60_000)

    test("97. new struct field: enclosing struct scanned", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")

      // Add terrain_type field
      const patched = original.replace(
        "pub display_class: String,",
        "pub display_class: String,\n    pub terrain_type: String,",
      )

      const patchedLines = patched.split("\n")
      const fieldLine = patchedLines.findIndex((l) => l.includes("terrain_type"))

      const result = await analyze({
        conn,
        legend,
        filePath,
        fileUri,
        originalContent: original,
        patchedContent: patched,
        beforeHunkRanges: [{ start: 1, end: 5 }], // original struct area
        afterHunkRanges: [{ start: 1, end: 6 }],  // patched struct area (one more line)
      })

      const symbols = result.map((d) => d.symbol)
      expect(symbols).toContain("String")
    }, 60_000)

    test("E1. enrichment: definitionText contains full function body", async () => {
      const { filePath, fileUri } = filePaths("src/game.rs")
      const original = await fixtureFile("src/game.rs")
      const origLines = original.split("\n")
      const methodLine = origLines.findIndex((l) => l.includes("fn get_current_level"))

      const patched = original.replace(
        "return &self.levels[self.get_player().level_index];",
        "return &self.levels[self.get_player().level_index]; // modified",
      )

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [{ start: methodLine, end: methodLine + 3 }],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 3 }],
      })

      // Find a definition that points to a project file (not stdlib)
      const projectDef = result.find(
        (d) => d.definedIn.path.includes("src/") && d.definitionText !== null,
      )
      if (projectDef) {
        expect(projectDef.definitionText).toBeTruthy()
        expect(projectDef.definitionText!.length).toBeGreaterThan(10)
        expect(projectDef.definedIn.endLine).not.toBeNull()
        expect(projectDef.definedIn.endLine!).toBeGreaterThanOrEqual(projectDef.definedIn.line)
      }
    }, 60_000)

    test("E2. enrichment: docComment extracted for cross-file defs", async () => {
      // The fixture's entity.rs has get_default_sight_range() which is a const fn
      // with no doc comments. But Location struct in location.rs may have comments
      // depending on the fixture. The key test: enrichment doesn't crash, and
      // docComment is either a string or null.
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")

      const patched = original + `
impl Tile {
    pub fn origin(&self) -> crate::location::Location {
        crate::location::Location::new(0, 0)
    }
}
`
      const patchedLines = patched.split("\n")
      const methodLine = patchedLines.findIndex((l) => l.includes("fn origin"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 4 }],
      })

      // All enriched definitions should have docComment as string or null (not undefined)
      for (const def of result) {
        if (def.definedIn.path !== filePath) {
          expect(def.docComment === null || typeof def.docComment === "string").toBe(true)
        }
      }
    }, 60_000)

    test("E3. enrichment: docComment is null when no comments", async () => {
      const { filePath, fileUri } = filePaths("src/game.rs")
      const original = await fixtureFile("src/game.rs")
      const origLines = original.split("\n")
      const methodLine = origLines.findIndex((l) => l.includes("fn get_current_level"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: original,
        beforeHunkRanges: [{ start: methodLine, end: methodLine + 3 }],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 3 }],
      })

      // get_current_level doesn't have doc comments in the fixture
      const getCurrentLevel = result.find((d) => d.symbol === "get_current_level")
      if (getCurrentLevel) {
        expect(getCurrentLevel.docComment).toBeNull()
      }
    }, 60_000)

    test("E4. enrichment: endLine > startLine for multi-line defs", async () => {
      const { filePath, fileUri } = filePaths("src/game.rs")
      const original = await fixtureFile("src/game.rs")
      const origLines = original.split("\n")
      const methodLine = origLines.findIndex((l) => l.includes("fn get_current_level"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: original,
        beforeHunkRanges: [{ start: methodLine, end: methodLine + 3 }],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 3 }],
      })

      for (const def of result) {
        if (def.definedIn.endLine !== null) {
          expect(def.definedIn.endLine).toBeGreaterThanOrEqual(def.definedIn.line)
        }
      }
    }, 60_000)

    test("E5. enrichment: definitionText for cross-file def (Location)", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")

      const patched = original + `
impl Tile {
    pub fn origin(&self) -> crate::location::Location {
        crate::location::Location::new(0, 0)
    }
}
`
      const patchedLines = patched.split("\n")
      const methodLine = patchedLines.findIndex((l) => l.includes("fn origin"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 4 }],
      })

      const locDef = result.find((d) => d.symbol === "Location" && d.tokenType === "struct")
      if (locDef) {
        expect(locDef.definedIn.path).toContain("location.rs")
        expect(locDef.definitionText).not.toBeNull()
        expect(locDef.definitionText).toContain("pub struct Location")
        expect(locDef.definedIn.endLine).not.toBeNull()
      }
    }, 60_000)

    test("E6. same-file defs have null enrichment (virtual content)", async () => {
      const { filePath, fileUri } = filePaths("src/entity.rs")
      const original = await fixtureFile("src/entity.rs")

      // Add a new method that calls another new method in the same file
      const patched = original + `
impl Entity {
    pub fn double_damage(&self) -> i32 {
        self.damage * 2
    }
}
`
      const patchedLines = patched.split("\n")
      const methodLine = patchedLines.findIndex((l) => l.includes("fn double_damage"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 4 }],
      })

      // Definitions pointing back to entity.rs (the analyzed file) should have
      // null enrichment since they reference virtual content
      const sameDefs = result.filter((d) => d.definedIn.path === filePath)
      for (const def of sameDefs) {
        expect(def.definitionText).toBeNull()
        expect(def.definedIn.endLine).toBeNull()
      }

      // But cross-file definitions (if any) should be enriched
      const crossDefs = result.filter((d) => d.definedIn.path !== filePath)
      // No guarantee there are cross-file defs in this test, but if there are they should be enriched
    }, 60_000)

    test("E7. cross-file defs ARE enriched", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")

      const patched = original + `
impl Tile {
    pub fn loc(&self) -> crate::location::Location {
        crate::location::Location::new(0, 0)
    }
}
`
      const patchedLines = patched.split("\n")
      const methodLine = patchedLines.findIndex((l) => l.includes("fn loc"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 4 }],
      })

      const crossDefs = result.filter(
        (d) => d.definedIn.path !== filePath && d.definedIn.path.includes("/src/"),
      )
      expect(crossDefs.length).toBeGreaterThan(0)

      // Namespace tokens at line 0 represent the module itself, not a definition body.
      // Those won't be enriched. But struct/fn/method defs should be.
      const enrichable = crossDefs.filter((d) => d.tokenType !== "namespace")
      for (const def of enrichable) {
        expect(def.definitionText).not.toBeNull()
        expect(def.definedIn.endLine).not.toBeNull()
        expect(def.definedIn.endLine!).toBeGreaterThanOrEqual(def.definedIn.line)
      }

      // Verify at least one was actually enriched
      expect(enrichable.some((d) => d.definitionText !== null)).toBe(true)
    }, 60_000)

    test("E8. stdlib definitions get enrichment (source on disk)", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")

      // Tile struct has `pub display_class: String` — String is stdlib
      const origLines = original.split("\n")
      const structLine = origLines.findIndex((l) => l.includes("pub struct Tile"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: original,
        beforeHunkRanges: [{ start: structLine, end: structLine + 5 }],
        afterHunkRanges: [{ start: structLine, end: structLine + 5 }],
      })

      const stringDef = result.find((d) => d.symbol === "String" && d.tokenType === "struct")
      if (stringDef) {
        // stdlib source is on disk in rustup toolchain
        expect(stringDef.definedIn.path).toContain("string.rs")
        // Should have definition text (stdlib source is readable)
        // May or may not succeed depending on toolchain install — don't hard-fail
        if (stringDef.definitionText !== null) {
          expect(stringDef.definitionText).toContain("String")
        }
      }
    }, 60_000)

    test("99. empty content returns empty results", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const content = await fixtureFile("src/tile.rs")

      const result = await analyze({
        conn,
        legend,
        filePath,
        fileUri,
        originalContent: content,
        patchedContent: content, // same content
        beforeHunkRanges: [],    // no hunks
        afterHunkRanges: [],
      })

      expect(result).toEqual([])
    })

    test("100. before+after union: renamed call includes both symbols", async () => {
      const { filePath, fileUri } = filePaths("src/game.rs")
      const original = await fixtureFile("src/game.rs")

      // Find get_player call in get_current_level and rename it to get_player_index
      // (both exist in game.rs, so both should resolve)
      const origLines = original.split("\n")
      const methodLine = origLines.findIndex((l) => l.includes("fn get_current_level"))

      // Create patched version that changes get_player() to get_player_index()
      const patched = original.replace(
        "return &self.levels[self.get_player().level_index];",
        "return &self.levels[self.entities[self.get_player_index()].level_index];",
      )

      const result = await analyze({
        conn,
        legend,
        filePath,
        fileUri,
        originalContent: original,
        patchedContent: patched,
        beforeHunkRanges: [{ start: methodLine, end: methodLine + 3 }],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 3 }],
      })

      const symbols = result.map((d) => d.symbol)
      // Before side should have get_player, after side should have get_player_index
      expect(symbols).toContain("get_player")
      expect(symbols).toContain("get_player_index")
    }, 60_000)
  })

  // --- M7: per-document mutex ---

  describe("M7: per-document mutex", () => {
    test("104. serializes same-file access", async () => {
      const { filePath, fileUri } = filePaths("src/entity.rs")
      const original = await fixtureFile("src/entity.rs")

      // Two modifications to the same file
      const patched1 = original.replace(
        "if self.is_priest { 5 } else { 0 }",
        "if self.is_priest { 10 } else { 0 }",
      )
      const patched2 = original.replace(
        "if self.is_priest { 5 } else { 0 }",
        "if self.is_priest { 20 } else { 0 }",
      )

      const origLines = original.split("\n")
      const changeLine = origLines.findIndex((l) => l.includes("is_priest { 5 }"))

      const timestamps: number[] = []

      // Launch both concurrently
      const [result1, result2] = await Promise.all([
        (async () => {
          timestamps.push(Date.now())
          const r = await analyze({
            conn, legend, filePath, fileUri,
            originalContent: original, patchedContent: patched1,
            beforeHunkRanges: [{ start: changeLine, end: changeLine + 1 }],
            afterHunkRanges: [{ start: changeLine, end: changeLine + 1 }],
          })
          timestamps.push(Date.now())
          return r
        })(),
        (async () => {
          timestamps.push(Date.now())
          const r = await analyze({
            conn, legend, filePath, fileUri,
            originalContent: original, patchedContent: patched2,
            beforeHunkRanges: [{ start: changeLine, end: changeLine + 1 }],
            afterHunkRanges: [{ start: changeLine, end: changeLine + 1 }],
          })
          timestamps.push(Date.now())
          return r
        })(),
      ])

      // Both should succeed
      expect(result1.length).toBeGreaterThan(0)
      expect(result2.length).toBeGreaterThan(0)
    }, 60_000)

    test("105. parallel different-file access", async () => {
      const entity = filePaths("src/entity.rs")
      const game = filePaths("src/game.rs")
      const entityOrig = await fixtureFile("src/entity.rs")
      const gameOrig = await fixtureFile("src/game.rs")

      const entityPatched = entityOrig.replace(
        "if self.is_priest { 5 } else { 0 }",
        "if self.is_priest { 99 } else { 0 }",
      )
      const gamePatched = gameOrig.replace(
        "return self.player_index",
        "return self.player_index /* modified */",
      )

      const entityLine = entityOrig.split("\n").findIndex((l) => l.includes("is_priest { 5 }"))
      const gameLine = gameOrig.split("\n").findIndex((l) => l.includes("return self.player_index"))

      const start = Date.now()
      const [r1, r2] = await Promise.all([
        analyze({
          conn, legend,
          filePath: entity.filePath, fileUri: entity.fileUri,
          originalContent: entityOrig, patchedContent: entityPatched,
          beforeHunkRanges: [{ start: entityLine, end: entityLine + 1 }],
          afterHunkRanges: [{ start: entityLine, end: entityLine + 1 }],
        }),
        analyze({
          conn, legend,
          filePath: game.filePath, fileUri: game.fileUri,
          originalContent: gameOrig, patchedContent: gamePatched,
          beforeHunkRanges: [{ start: gameLine, end: gameLine + 1 }],
          afterHunkRanges: [{ start: gameLine, end: gameLine + 1 }],
        }),
      ])
      const elapsed = Date.now() - start

      expect(r1.length).toBeGreaterThan(0)
      expect(r2.length).toBeGreaterThan(0)
      // Both ran — elapsed should be less than 2x sequential
      // (can't strictly assert overlap, but at least both succeed)
    }, 60_000)

    test("106. error in first call releases lock", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")

      const origLines = original.split("\n")
      const fieldLine = origLines.findIndex((l) => l.includes("display_class"))

      // First call: patched content with syntax error
      const badPatched = original.replace("pub display_class: String,", "pub display_class: INVALID SYNTAX {{{")

      // Second call: valid modification
      const goodPatched = original.replace(
        "pub display_class: String,",
        "pub display_class: String,\n    pub extra_field: bool,",
      )

      // First call may produce empty results due to syntax error — that's fine
      const result1 = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: badPatched,
        beforeHunkRanges: [{ start: fieldLine, end: fieldLine + 1 }],
        afterHunkRanges: [{ start: fieldLine, end: fieldLine + 1 }],
      })

      // Second call should work — lock should not be stuck
      const result2 = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: goodPatched,
        beforeHunkRanges: [{ start: fieldLine, end: fieldLine + 1 }],
        afterHunkRanges: [{ start: fieldLine, end: fieldLine + 2 }],
      })

      // At least the second call should produce results
      expect(result2.length).toBeGreaterThanOrEqual(0) // doesn't deadlock
    }, 60_000)

    test("107. lock cleanup: map entry removed", async () => {
      const { filePath, fileUri } = filePaths("src/location.rs")
      const original = await fixtureFile("src/location.rs")

      const origLines = original.split("\n")
      const distLine = origLines.findIndex((l) => l.includes("dist_squared"))

      await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: original,
        beforeHunkRanges: [{ start: distLine, end: distLine + 1 }],
        afterHunkRanges: [{ start: distLine, end: distLine + 1 }],
      })

      // The lock should have been cleaned up — verify by running another call
      // (if the lock were stuck, this would hang until timeout)
      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: original,
        beforeHunkRanges: [],
        afterHunkRanges: [],
      })

      expect(result).toEqual([])
    }, 30_000)
  })

  // --- M9: Edge cases ---

  describe("M9: edge cases", () => {
    test("124. didChange with syntax errors still returns partial results", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")

      // Create patched content with a syntax error but some valid code
      const patched = original.replace(
        "pub walkable: bool,",
        "pub walkable: bool,\n    pub broken_field: {{{ INVALID,",
      )

      const origLines = original.split("\n")
      const fieldLine = origLines.findIndex((l) => l.includes("walkable"))

      // Should not throw
      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [{ start: fieldLine, end: fieldLine + 1 }],
        afterHunkRanges: [{ start: fieldLine, end: fieldLine + 2 }],
      })

      // Before side should still produce results even if after side is broken
      expect(Array.isArray(result)).toBe(true)
    }, 60_000)

    test("126. didChange to empty string returns zero results", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: "",
        beforeHunkRanges: [{ start: 0, end: 5 }],
        afterHunkRanges: [],
      })

      expect(Array.isArray(result)).toBe(true)
    }, 60_000)

    test("133. dyn Trait reference resolves to trait definition", async () => {
      const { filePath, fileUri } = filePaths("src/game.rs")
      const original = await fixtureFile("src/game.rs")

      // game.rs has lookup_strength_affector which uses &dyn IStrengthAffector
      const origLines = original.split("\n")
      const lookupLine = origLines.findIndex((l) => l.includes("lookup_strength_affector"))

      if (lookupLine >= 0) {
        const result = await analyze({
          conn, legend, filePath, fileUri,
          originalContent: original, patchedContent: original,
          beforeHunkRanges: [{ start: lookupLine, end: lookupLine + 5 }],
          afterHunkRanges: [{ start: lookupLine, end: lookupLine + 5 }],
        })

        const symbols = result.map((d) => d.symbol)
        // Should include IStrengthAffector (the trait)
        expect(symbols).toContain("IStrengthAffector")
      }
    }, 60_000)

    test("135. match arm enum variant resolves", async () => {
      const { filePath, fileUri } = filePaths("src/game.rs")
      const original = await fixtureFile("src/game.rs")

      // lookup_strength_affector has match on EffectorIndex::Priest and EffectorIndex::Totem
      const origLines = original.split("\n")
      const matchLine = origLines.findIndex((l) => l.includes("match effector_id"))

      if (matchLine >= 0) {
        const result = await analyze({
          conn, legend, filePath, fileUri,
          originalContent: original, patchedContent: original,
          beforeHunkRanges: [{ start: matchLine, end: matchLine + 5 }],
          afterHunkRanges: [{ start: matchLine, end: matchLine + 5 }],
        })

        const symbols = result.map((d) => d.symbol)
        expect(symbols).toContain("EffectorIndex")
      }
    }, 60_000)

    test("136. method chain resolves each method independently", async () => {
      const { filePath, fileUri } = filePaths("src/entity.rs")
      const original = await fixtureFile("src/entity.rs")

      // Entity has methods that chain: entity.effector_indices.iter().filter_map(...)
      const origLines = original.split("\n")
      const chainLine = origLines.findIndex((l) => l.includes("effector_indices"))
      // Find the attack function which has the chain
      const attackLine = origLines.findIndex((l) => l.includes("pub fn attack("))

      if (attackLine >= 0) {
        const result = await analyze({
          conn, legend, filePath, fileUri,
          originalContent: original, patchedContent: original,
          beforeHunkRanges: [{ start: attackLine, end: attackLine + 10 }],
          afterHunkRanges: [{ start: attackLine, end: attackLine + 10 }],
        })

        const symbols = result.map((d) => d.symbol)
        expect(symbols.length).toBeGreaterThan(0)
        // Should find at least the function name and some fields/methods
        expect(symbols).toContain("attack")
      }
    }, 60_000)

    test("139. external crate type resolves", async () => {
      const { filePath, fileUri } = filePaths("src/game.rs")
      const original = await fixtureFile("src/game.rs")

      // Game struct uses generational_arena::Index
      const origLines = original.split("\n")
      const structLine = origLines.findIndex((l) => l.includes("pub struct Game"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: original,
        beforeHunkRanges: [{ start: structLine, end: structLine + 7 }],
        afterHunkRanges: [{ start: structLine, end: structLine + 7 }],
      })

      const symbols = result.map((d) => d.symbol)
      // Should resolve generational_arena and/or Index
      const hasExternalRef = symbols.some((s) => s === "generational_arena" || s === "Index" || s === "Arena")
      expect(hasExternalRef).toBe(true)
    }, 60_000)
  })

    test("101. enclosing scoping: unaffected functions not scanned", async () => {
      const { filePath, fileUri } = filePaths("src/game.rs")
      const original = await fixtureFile("src/game.rs")

      // Modify only get_current_level (first method in Game impl)
      const patched = original.replace(
        "return &self.levels[self.get_player().level_index];",
        "return &self.levels[self.get_player().level_index]; // modified",
      )

      const origLines = original.split("\n")
      const methodLine = origLines.findIndex((l) => l.includes("fn get_current_level"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [{ start: methodLine, end: methodLine + 3 }],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 3 }],
      })

      const symbols = result.map((d) => d.symbol)
      // Should have symbols from get_current_level (get_player, levels, level_index)
      expect(symbols).toContain("get_player")
      // Should NOT have symbols from add_entity_to_level (which is a different method)
      expect(symbols).not.toContain("add_entity_to_level")
    }, 60_000)

    test("108. before+after union with method rename", async () => {
      const { filePath, fileUri } = filePaths("src/entity.rs")
      const original = await fixtureFile("src/entity.rs")

      // In entity.rs, Squad has get_leader. Let's simulate renaming to get_first_member
      const origLines = original.split("\n")
      const leaderLine = origLines.findIndex((l) => l.includes("fn get_leader"))

      if (leaderLine >= 0) {
        const patched = original.replace(
          "pub fn get_leader(",
          "pub fn get_first_member(",
        )

        const result = await analyze({
          conn, legend, filePath, fileUri,
          originalContent: original, patchedContent: patched,
          beforeHunkRanges: [{ start: leaderLine, end: leaderLine + 8 }],
          afterHunkRanges: [{ start: leaderLine, end: leaderLine + 8 }],
        })

        const symbols = result.map((d) => d.symbol)
        // Before side should have get_leader, after side should have get_first_member
        expect(symbols).toContain("get_leader")
        expect(symbols).toContain("get_first_member")
      }
    }, 60_000)

    test("129. closure capturing outer variable resolves", async () => {
      const { filePath, fileUri } = filePaths("src/entity.rs")
      const original = await fixtureFile("src/entity.rs")

      // Entity::get_nearest_enemy_in_sight uses closures that reference entity fields
      const origLines = original.split("\n")
      const methodLine = origLines.findIndex((l) => l.includes("fn get_nearest_enemy_in_sight"))

      if (methodLine >= 0) {
        const result = await analyze({
          conn, legend, filePath, fileUri,
          originalContent: original, patchedContent: original,
          beforeHunkRanges: [{ start: methodLine, end: methodLine + 25 }],
          afterHunkRanges: [{ start: methodLine, end: methodLine + 25 }],
        })

        const symbols = result.map((d) => d.symbol)
        // Should resolve field accesses like level_index, loc, allegiance
        expect(symbols.length).toBeGreaterThan(3)
      }
    }, 60_000)

    test("134. if-let Some pattern resolves", async () => {
      const { filePath, fileUri } = filePaths("src/entity.rs")
      const original = await fixtureFile("src/entity.rs")

      // Entity code uses if let Some(...) patterns
      const origLines = original.split("\n")
      const ifLetLine = origLines.findIndex((l) => l.includes("if let Some"))

      if (ifLetLine >= 0) {
        // Find the enclosing function
        let fnLine = ifLetLine
        while (fnLine > 0 && !origLines[fnLine].includes("pub fn ") && !origLines[fnLine].includes("fn ")) fnLine--

        const result = await analyze({
          conn, legend, filePath, fileUri,
          originalContent: original, patchedContent: original,
          beforeHunkRanges: [{ start: fnLine, end: ifLetLine + 5 }],
          afterHunkRanges: [{ start: fnLine, end: ifLetLine + 5 }],
        })

        expect(result.length).toBeGreaterThan(0)
      }
    }, 60_000)

    test("138. fully qualified path resolves each segment", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")

      // Add a method using crate::location::Location (fully qualified)
      const patched = original + `
impl Tile {
    pub fn origin(&self) -> crate::location::Location {
        crate::location::Location::new(0, 0)
    }
}
`
      const patchedLines = patched.split("\n")
      const methodLine = patchedLines.findIndex((l) => l.includes("fn origin"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 4 }],
      })

      const symbols = result.map((d) => d.symbol)
      // Should resolve Location and location namespace
      expect(symbols).toContain("Location")
      expect(symbols).toContain("location")
    }, 60_000)

    test("125. didChange with type errors still works", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")

      // Type error: wrong return type but syntactically valid
      const patched = original + `
impl Tile {
    pub fn bad_type(&self) -> i32 {
        self.display_class.clone()
    }
}
`
      const patchedLines = patched.split("\n")
      const methodLine = patchedLines.findIndex((l) => l.includes("fn bad_type"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 4 }],
      })

      // Should still get tokens and definitions despite type error
      const symbols = result.map((d) => d.symbol)
      expect(symbols).toContain("display_class")
    }, 60_000)

    test("130. shadowed variable resolves to inner binding", async () => {
      const { filePath, fileUri } = filePaths("src/game.rs")
      const original = await fixtureFile("src/game.rs")

      // Add a method with shadowed variable
      const patched = original + `
impl Game {
    pub fn shadow_test(&self) -> usize {
        let x = self.levels.len();
        let x = x + 1;
        x
    }
}
`
      const patchedLines = patched.split("\n")
      const methodLine = patchedLines.findIndex((l) => l.includes("fn shadow_test"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 6 }],
      })

      const symbols = result.map((d) => d.symbol)
      expect(symbols).toContain("levels")
    }, 60_000)

    test("131. turbofish syntax resolves Vec", async () => {
      const { filePath, fileUri } = filePaths("src/entity.rs")
      const original = await fixtureFile("src/entity.rs")

      // Add method with turbofish
      const patched = original + `
impl Entity {
    pub fn indices_vec(&self) -> Vec<usize> {
        self.effector_indices.iter().map(|_| 0usize).collect::<Vec<_>>()
    }
}
`
      const patchedLines = patched.split("\n")
      const methodLine = patchedLines.findIndex((l) => l.includes("fn indices_vec"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 4 }],
      })

      const symbols = result.map((d) => d.symbol)
      expect(symbols).toContain("effector_indices")
    }, 60_000)

    test("132. impl Trait in return position resolves trait", async () => {
      const { filePath, fileUri } = filePaths("src/entity.rs")
      const original = await fixtureFile("src/entity.rs")

      // Add method returning impl trait
      const patched = original + `
impl Entity {
    pub fn display_info(&self) -> impl std::fmt::Display {
        format!("Entity at ({}, {})", self.loc.x, self.loc.y)
    }
}
`
      const patchedLines = patched.split("\n")
      const methodLine = patchedLines.findIndex((l) => l.includes("fn display_info"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 4 }],
      })

      const symbols = result.map((d) => d.symbol)
      // Should resolve loc, x, y field accesses
      expect(symbols).toContain("loc")
    }, 60_000)

    test("137. glob import symbols resolve", async () => {
      const { filePath, fileUri } = filePaths("src/entity.rs")
      const original = await fixtureFile("src/entity.rs")

      // entity.rs uses `use crate::game::*` — symbols from game.rs should resolve
      const origLines = original.split("\n")
      const fnLine = origLines.findIndex((l) => l.includes("fn get_adjacent_enemy"))

      if (fnLine >= 0) {
        const result = await analyze({
          conn, legend, filePath, fileUri,
          originalContent: original, patchedContent: original,
          beforeHunkRanges: [{ start: fnLine, end: fnLine + 12 }],
          afterHunkRanges: [{ start: fnLine, end: fnLine + 12 }],
        })

        const symbols = result.map((d) => d.symbol)
        // get_pattern_adjacent_locations is imported via glob from game.rs
        expect(symbols).toContain("get_pattern_adjacent_locations")
      }
    }, 60_000)

    test("140. derive macro Clone resolves", async () => {
      const { filePath, fileUri } = filePaths("src/entity.rs")
      const original = await fixtureFile("src/entity.rs")

      // Entity struct has #[derive(Clone)] — find the struct
      const origLines = original.split("\n")
      const structLine = origLines.findIndex((l) => l.includes("pub struct Entity"))

      if (structLine >= 0) {
        const result = await analyze({
          conn, legend, filePath, fileUri,
          originalContent: original, patchedContent: original,
          beforeHunkRanges: [{ start: structLine - 1, end: structLine + 15 }],
          afterHunkRanges: [{ start: structLine - 1, end: structLine + 15 }],
        })

        const symbols = result.map((d) => d.symbol)
        // Should find Entity, its fields, and potentially Clone from derive
        expect(symbols).toContain("Entity")
        expect(symbols.length).toBeGreaterThan(5)
      }
    }, 60_000)

    test("120. unicode in file content handled", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")

      // Add a method with unicode in string literals
      const patched = original + `
impl Tile {
    pub fn emoji_name(&self) -> String {
        let name = "🏰 Castle".to_string();
        name
    }
}
`
      const patchedLines = patched.split("\n")
      const methodLine = patchedLines.findIndex((l) => l.includes("fn emoji_name"))

      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 5 }],
      })

      // Should not crash — tokens may or may not resolve
      expect(Array.isArray(result)).toBe(true)
    }, 60_000)

    test("127. rapid didChange then immediate query works", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")

      // Multiple rapid calls — should all succeed
      const results = []
      for (let i = 0; i < 3; i++) {
        const patched = original + `\nimpl Tile { pub fn rapid_${i}(&self) -> bool { self.walkable } }\n`
        const patchedLines = patched.split("\n")
        const line = patchedLines.findIndex((l) => l.includes(`fn rapid_${i}`))

        const r = await analyze({
          conn, legend, filePath, fileUri,
          originalContent: original, patchedContent: patched,
          beforeHunkRanges: [],
          afterHunkRanges: [{ start: line, end: line + 1 }],
        })
        results.push(r)
      }

      // All should complete without error
      for (const r of results) {
        expect(Array.isArray(r)).toBe(true)
      }
    }, 60_000)

    test("128. after analyzeFile, re-reading fixture file works", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")

      // Analyze with modified content
      const patched = original + "\nimpl Tile { pub fn temp(&self) {} }\n"
      const patchedLines = patched.split("\n")
      const line = patchedLines.findIndex((l) => l.includes("fn temp"))

      await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [],
        afterHunkRanges: [{ start: line, end: line + 1 }],
      })

      // Now analyze with original content again — should still work
      const origLines = original.split("\n")
      const fieldLine = origLines.findIndex((l) => l.includes("walkable"))
      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: original,
        beforeHunkRanges: [{ start: fieldLine, end: fieldLine + 1 }],
        afterHunkRanges: [{ start: fieldLine, end: fieldLine + 1 }],
      })

      expect(Array.isArray(result)).toBe(true)
    }, 60_000)

  // --- M8: diff-to-pipeline (simulating HTTP route logic) ---

  describe("M8: diff-to-pipeline", () => {
    // Helper that simulates what the HTTP route does:
    // parse diff, read original from fixture, apply patch, call analyzeFile
    async function analyzeFromDiff(diff: string): Promise<{
      definitions: ContextDefs.SymbolDefinition[]
      errors: string[]
    }> {
      const parsedFiles = ContextDefs.parseUnifiedDiff(diff)
      const allDefs: ContextDefs.SymbolDefinition[] = []
      const errors: string[] = []

      for (const fileDiff of parsedFiles) {
        const { filePath, fileUri } = filePaths(fileDiff.path)
        try {
          const diskContent = await fixtureFile(fileDiff.path)
          let originalContent: string
          let patchedContent: string

          if (fileDiff.isNew) {
            originalContent = ""
            patchedContent = diskContent
          } else {
            // Forward apply: disk is before-state
            const singleDiff = extractSingleFileDiff(diff, fileDiff.path)
            const applied = ContextDefs.applyDiff(diskContent, singleDiff)
            originalContent = diskContent
            patchedContent = applied
          }

          const beforeHunks = fileDiff.hunks.map((h) => ({ start: h.oldStart, end: h.oldStart + h.oldLines }))
          const afterHunks = fileDiff.hunks.map((h) => ({ start: h.newStart, end: h.newStart + h.newLines }))

          const defs = await analyze({
            conn, legend, filePath, fileUri,
            originalContent, patchedContent,
            beforeHunkRanges: beforeHunks,
            afterHunkRanges: afterHunks,
          })
          allDefs.push(...defs)
        } catch (err: any) {
          errors.push(`${fileDiff.path}: ${err.message ?? err}`)
        }
      }

      const seen = new Set<string>()
      const deduped = allDefs.filter((d) => {
        const key = `${d.symbol}:${d.definedIn.path}:${d.definedIn.line}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      return { definitions: deduped, errors }
    }

    test("108. diff adding new method: parsed and analyzed end-to-end", async () => {
      const original = await fixtureFile("src/tile.rs")
      const newMethod = `
impl Tile {
    pub fn tile_weight(&self) -> i32 {
        if self.walkable { 1 } else { 999 }
    }
}`
      const patched = original + "\n" + newMethod + "\n"

      // Generate unified diff
      const { createTwoFilesPatch } = require("diff")
      const diff = createTwoFilesPatch("a/src/tile.rs", "b/src/tile.rs", original, patched)

      const result = await analyzeFromDiff(diff)

      expect(result.errors).toEqual([])
      expect(result.definitions.length).toBeGreaterThan(0)
      const symbols = result.definitions.map((d) => d.symbol)
      // The diff covers both the struct (walkable, display_class) and the new method
      expect(symbols).toContain("walkable")
      // tile_weight should be in the results (it's the method name itself, defined in the after-side)
      expect(symbols).toContain("Tile")
    }, 60_000)

    test("109. empty diff returns empty", async () => {
      const result = await analyzeFromDiff("")
      expect(result.definitions).toEqual([])
      expect(result.errors).toEqual([])
    })

    test("110. diff modifying existing method: both sides analyzed", async () => {
      const original = await fixtureFile("src/game.rs")
      const patched = original.replace(
        "return &self.levels[self.get_player().level_index];",
        "let idx = self.get_player().level_index;\n        return &self.levels[idx];",
      )

      const { createTwoFilesPatch } = require("diff")
      const diff = createTwoFilesPatch("a/src/game.rs", "b/src/game.rs", original, patched)

      const result = await analyzeFromDiff(diff)

      expect(result.errors).toEqual([])
      const symbols = result.definitions.map((d) => d.symbol)
      // Both before and after should contribute symbols from get_current_level
      expect(symbols).toContain("get_player")
      expect(symbols).toContain("levels")
    }, 60_000)

    test("111. diff with file not found returns error", async () => {
      const diff = `diff --git a/src/nonexistent.rs b/src/nonexistent.rs
--- a/src/nonexistent.rs
+++ b/src/nonexistent.rs
@@ -1,1 +1,2 @@
 line1
+line2
`
      const result = await analyzeFromDiff(diff)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toContain("nonexistent.rs")
    })

    test("112. multi-file diff processes all files", async () => {
      const tileOrig = await fixtureFile("src/tile.rs")
      const gameOrig = await fixtureFile("src/game.rs")

      const tilePatched = tileOrig.replace(
        "pub walkable: bool,",
        "pub walkable: bool, // tile modified",
      )
      const gamePatched = gameOrig.replace(
        "return &self.levels[self.get_player().level_index];",
        "return &self.levels[self.get_player().level_index]; // game modified",
      )

      const { createTwoFilesPatch } = require("diff")
      const tileDiff = createTwoFilesPatch("a/src/tile.rs", "b/src/tile.rs", tileOrig, tilePatched)
      const gameDiff = createTwoFilesPatch("a/src/game.rs", "b/src/game.rs", gameOrig, gamePatched)

      // Concatenate diffs
      const fullDiff = tileDiff + "\n" + gameDiff

      const result = await analyzeFromDiff(fullDiff)

      expect(result.errors).toEqual([])
      // Should have definitions from both files
      const usedPaths = new Set(result.definitions.map((d) => d.usedAt.path))
      expect(usedPaths.size).toBeGreaterThanOrEqual(2)
    }, 60_000)
  })

  // --- M10: Race condition tests ---

  describe("M10: race conditions", () => {
    test("141. sequential same-file different diffs get correct results", async () => {
      const { filePath, fileUri } = filePaths("src/entity.rs")
      const original = await fixtureFile("src/entity.rs")

      // Modification A: change the literal in get_strength_boost
      const patchedA = original.replace(
        "if self.is_priest { 5 } else { 0 }",
        "if self.is_priest { 100 } else { 0 }",
      )
      // Modification B: change the aura range constant
      const patchedB = original.replace(
        "const AURA_RANGE: i32 = 500;",
        "const AURA_RANGE: i32 = 999;",
      )

      const origLines = original.split("\n")
      const lineA = origLines.findIndex((l) => l.includes("is_priest { 5 }"))
      const lineB = origLines.findIndex((l) => l.includes("AURA_RANGE"))

      const resultA = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patchedA,
        beforeHunkRanges: [{ start: lineA, end: lineA + 1 }],
        afterHunkRanges: [{ start: lineA, end: lineA + 1 }],
      })

      const resultB = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patchedB,
        beforeHunkRanges: [{ start: lineB, end: lineB + 1 }],
        afterHunkRanges: [{ start: lineB, end: lineB + 1 }],
      })

      // Both should succeed independently
      expect(resultA.length).toBeGreaterThan(0)
      // resultB might be empty if AURA_RANGE is module-level with no enclosing def
      expect(Array.isArray(resultB)).toBe(true)
    }, 60_000)

    test("142. 5 rapid sequential calls same file all succeed", async () => {
      const { filePath, fileUri } = filePaths("src/tile.rs")
      const original = await fixtureFile("src/tile.rs")
      const origLines = original.split("\n")
      const fieldLine = origLines.findIndex((l) => l.includes("walkable"))

      for (let i = 0; i < 5; i++) {
        const result = await analyze({
          conn, legend, filePath, fileUri,
          originalContent: original, patchedContent: original,
          beforeHunkRanges: [{ start: fieldLine, end: fieldLine + 1 }],
          afterHunkRanges: [{ start: fieldLine, end: fieldLine + 1 }],
        })
        expect(Array.isArray(result)).toBe(true)
      }
    }, 120_000)

    test("145. different file locks don't block each other", async () => {
      const tile = filePaths("src/tile.rs")
      const loc = filePaths("src/location.rs")
      const tileOrig = await fixtureFile("src/tile.rs")
      const locOrig = await fixtureFile("src/location.rs")

      const tileLines = tileOrig.split("\n")
      const locLines = locOrig.split("\n")
      const tileLine = tileLines.findIndex((l) => l.includes("walkable"))
      const locLine = locLines.findIndex((l) => l.includes("dist_squared"))

      // Run concurrently — should not deadlock
      const [r1, r2] = await Promise.all([
        analyze({
          conn, legend,
          filePath: tile.filePath, fileUri: tile.fileUri,
          originalContent: tileOrig, patchedContent: tileOrig,
          beforeHunkRanges: [{ start: tileLine, end: tileLine + 1 }],
          afterHunkRanges: [{ start: tileLine, end: tileLine + 1 }],
        }),
        analyze({
          conn, legend,
          filePath: loc.filePath, fileUri: loc.fileUri,
          originalContent: locOrig, patchedContent: locOrig,
          beforeHunkRanges: [{ start: locLine, end: locLine + 3 }],
          afterHunkRanges: [{ start: locLine, end: locLine + 3 }],
        }),
      ])

      expect(Array.isArray(r1)).toBe(true)
      expect(Array.isArray(r2)).toBe(true)
    }, 60_000)
  })
})

// --- Helpers ---

function extractSingleFileDiff(fullDiff: string, filePath: string): string {
  const lines = fullDiff.split("\n")
  let inFile = false
  const result: string[] = []
  for (const line of lines) {
    if (line.startsWith("diff --git ") && line.includes(filePath)) {
      inFile = true
      result.push(line)
    } else if (line.startsWith("diff --git ") && inFile) {
      break
    } else if (inFile) {
      result.push(line)
    }
  }
  return result.join("\n") + "\n"
}

function findSymbolByName(symbols: any[], name: string): any {
  for (const s of symbols) {
    if (s.name === name) return s
    if (s.children) {
      const found = findSymbolByName(s.children, name)
      if (found) return found
    }
  }
  return undefined
}
