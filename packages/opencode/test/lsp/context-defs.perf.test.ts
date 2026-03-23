/**
 * Performance tests for context-defs.
 * Verifies that analysis completes within acceptable time bounds.
 */
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

function filePaths(relPath: string) {
  const abs = path.join(sandboxDir, relPath)
  return { filePath: abs, fileUri: pathToFileURL(abs).href }
}

describe("context-defs performance", () => {
  beforeAll(async () => {
    sandboxDir = await mkdtemp(path.join(os.tmpdir(), "opencode-perf-"))
    await cp(FIXTURE, sandboxDir, { recursive: true })

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
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
      },
    })
    legend = (initResult as any).capabilities?.semanticTokensProvider?.legend
    await conn.sendNotification("initialized", {})

    // Wait for indexing
    const start = Date.now()
    while (activeProgress.size === 0 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 100))
    while (activeProgress.size > 0 && Date.now() - start < 60000) await new Promise((r) => setTimeout(r, 200))
    await new Promise((r) => setTimeout(r, 300))
  }, 120_000)

  afterAll(async () => {
    if (conn) { conn.end(); conn.dispose() }
    if (proc) proc.kill()
    if (sandboxDir) await rm(sandboxDir, { recursive: true, force: true }).catch(() => {})
  })

  test("small change completes under 500ms", async () => {
    const { filePath, fileUri } = filePaths("src/entity.rs")
    const original = await readFile(filePath, "utf-8")
    const patched = original.replace(
      "if self.is_priest { 5 } else { 0 }",
      "if self.is_priest { 10 } else { 0 }",
    )
    const line = original.split("\n").findIndex((l) => l.includes("is_priest { 5 }"))

    // Warmup
    await analyze({
      conn, legend, filePath, fileUri,
      originalContent: original, patchedContent: patched,
      beforeHunkRanges: [{ start: line, end: line + 1 }],
      afterHunkRanges: [{ start: line, end: line + 1 }],
    })

    const start = Date.now()
    const result = await analyze({
      conn, legend, filePath, fileUri,
      originalContent: original, patchedContent: patched,
      beforeHunkRanges: [{ start: line, end: line + 1 }],
      afterHunkRanges: [{ start: line, end: line + 1 }],
    })
    const elapsed = Date.now() - start

    expect(result.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(500)
    console.log(`  small change: ${elapsed}ms, ${result.length} defs`)
  }, 30_000)

  test("new method with cross-file refs completes under 500ms", async () => {
    const { filePath, fileUri } = filePaths("src/tile.rs")
    const original = await readFile(filePath, "utf-8")
    const patched = original + `
impl Tile {
    pub fn default_location(&self) -> crate::location::Location {
        crate::location::Location::new(0, 0)
    }
}
`
    const patchedLines = patched.split("\n")
    const methodLine = patchedLines.findIndex((l) => l.includes("fn default_location"))

    // Warmup
    await analyze({
      conn, legend, filePath, fileUri,
      originalContent: original, patchedContent: patched,
      beforeHunkRanges: [],
      afterHunkRanges: [{ start: methodLine, end: methodLine + 4 }],
    })

    const start = Date.now()
    const result = await analyze({
      conn, legend, filePath, fileUri,
      originalContent: original, patchedContent: patched,
      beforeHunkRanges: [],
      afterHunkRanges: [{ start: methodLine, end: methodLine + 4 }],
    })
    const elapsed = Date.now() - start

    expect(result.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(500)
    console.log(`  cross-file method: ${elapsed}ms, ${result.length} defs`)
  }, 30_000)

  test("large method (150 lines, ~100 defs) completes under 1000ms", async () => {
    const { filePath, fileUri } = filePaths("src/entity.rs")
    const original = await readFile(filePath, "utf-8")
    const lines = original.split("\n")
    const fnLine = lines.findIndex((l) => l.includes("fn process_entity_turn"))
    const endLine = Math.min(fnLine + 150, lines.length)

    // Warmup
    await analyze({
      conn, legend, filePath, fileUri,
      originalContent: original, patchedContent: original,
      beforeHunkRanges: [{ start: fnLine, end: endLine }],
      afterHunkRanges: [{ start: fnLine, end: endLine }],
    })

    const start = Date.now()
    const result = await analyze({
      conn, legend, filePath, fileUri,
      originalContent: original, patchedContent: original,
      beforeHunkRanges: [{ start: fnLine, end: endLine }],
      afterHunkRanges: [{ start: fnLine, end: endLine }],
    })
    const elapsed = Date.now() - start

    expect(result.length).toBeGreaterThan(50)
    expect(elapsed).toBeLessThan(1000)
    console.log(`  large method: ${elapsed}ms, ${result.length} defs`)
  }, 30_000)

  test("3 files in parallel completes under 1000ms", async () => {
    const entity = filePaths("src/entity.rs")
    const game = filePaths("src/game.rs")
    const tile = filePaths("src/tile.rs")

    const entityOrig = await readFile(entity.filePath, "utf-8")
    const gameOrig = await readFile(game.filePath, "utf-8")
    const tileOrig = await readFile(tile.filePath, "utf-8")

    const entityLine = entityOrig.split("\n").findIndex((l) => l.includes("is_priest { 5 }"))
    const gameLine = gameOrig.split("\n").findIndex((l) => l.includes("fn get_current_level"))
    const tileLine = tileOrig.split("\n").findIndex((l) => l.includes("walkable"))

    // Warmup
    await Promise.all([
      analyze({ conn, legend, filePath: entity.filePath, fileUri: entity.fileUri, originalContent: entityOrig, patchedContent: entityOrig, beforeHunkRanges: [{ start: entityLine, end: entityLine + 3 }], afterHunkRanges: [{ start: entityLine, end: entityLine + 3 }] }),
      analyze({ conn, legend, filePath: game.filePath, fileUri: game.fileUri, originalContent: gameOrig, patchedContent: gameOrig, beforeHunkRanges: [{ start: gameLine, end: gameLine + 3 }], afterHunkRanges: [{ start: gameLine, end: gameLine + 3 }] }),
      analyze({ conn, legend, filePath: tile.filePath, fileUri: tile.fileUri, originalContent: tileOrig, patchedContent: tileOrig, beforeHunkRanges: [{ start: tileLine, end: tileLine + 3 }], afterHunkRanges: [{ start: tileLine, end: tileLine + 3 }] }),
    ])

    const start = Date.now()
    const [r1, r2, r3] = await Promise.all([
      analyze({ conn, legend, filePath: entity.filePath, fileUri: entity.fileUri, originalContent: entityOrig, patchedContent: entityOrig, beforeHunkRanges: [{ start: entityLine, end: entityLine + 3 }], afterHunkRanges: [{ start: entityLine, end: entityLine + 3 }] }),
      analyze({ conn, legend, filePath: game.filePath, fileUri: game.fileUri, originalContent: gameOrig, patchedContent: gameOrig, beforeHunkRanges: [{ start: gameLine, end: gameLine + 3 }], afterHunkRanges: [{ start: gameLine, end: gameLine + 3 }] }),
      analyze({ conn, legend, filePath: tile.filePath, fileUri: tile.fileUri, originalContent: tileOrig, patchedContent: tileOrig, beforeHunkRanges: [{ start: tileLine, end: tileLine + 3 }], afterHunkRanges: [{ start: tileLine, end: tileLine + 3 }] }),
    ])
    const elapsed = Date.now() - start

    const total = r1.length + r2.length + r3.length
    expect(total).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(1000)
    console.log(`  3 files parallel: ${elapsed}ms, ${total} defs`)
  }, 30_000)
})
