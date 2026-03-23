/**
 * Performance benchmark for context-defs.
 * Run with: bun run test/lsp/context-defs.bench.ts
 */
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

async function main() {
  console.log("=== Context-Defs Performance Benchmark ===\n")

  // Setup
  console.log("Setting up sandbox...")
  const t0 = Date.now()
  const sandboxDir = await mkdtemp(path.join(os.tmpdir(), "opencode-bench-"))
  await cp(FIXTURE, sandboxDir, { recursive: true })

  const proc = spawn("rust-analyzer", [], {
    cwd: sandboxDir,
    stdio: ["pipe", "pipe", "pipe"],
  })
  proc.stderr.on("data", () => {})

  const conn = createMessageConnection(
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
    initializationOptions: { procMacro: { enable: false } },
  })
  const legend = (initResult as any).capabilities?.semanticTokensProvider?.legend
  await conn.sendNotification("initialized", {})

  // Wait for indexing
  const indexStart = Date.now()
  while (activeProgress.size === 0 && Date.now() - indexStart < 3000) {
    await new Promise((r) => setTimeout(r, 100))
  }
  while (activeProgress.size > 0 && Date.now() - indexStart < 60000) {
    await new Promise((r) => setTimeout(r, 200))
  }
  await new Promise((r) => setTimeout(r, 300))
  const setupMs = Date.now() - t0
  const indexMs = Date.now() - indexStart
  console.log(`Setup: ${setupMs}ms (indexing: ${indexMs}ms)\n`)

  // Helper
  function filePaths(relPath: string) {
    const abs = path.join(sandboxDir, relPath)
    return { filePath: abs, fileUri: pathToFileURL(abs).href }
  }

  async function bench(
    name: string,
    fn: () => Promise<ContextDefs.SymbolDefinition[]>,
  ) {
    // Warmup
    await fn()

    // Measure 3 runs
    const times: number[] = []
    let lastResult: ContextDefs.SymbolDefinition[] = []
    for (let i = 0; i < 3; i++) {
      const start = Date.now()
      lastResult = await fn()
      times.push(Date.now() - start)
    }

    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    const min = Math.min(...times)
    const max = Math.max(...times)
    const symbols = [...new Set(lastResult.map((d) => d.symbol))]

    console.log(`  ${name}`)
    console.log(`    avg: ${avg}ms  min: ${min}ms  max: ${max}ms  (${times.join(", ")}ms)`)
    console.log(`    ${lastResult.length} definitions, ${symbols.length} unique symbols`)
    console.log(`    symbols: ${symbols.slice(0, 15).join(", ")}${symbols.length > 15 ? "..." : ""}`)
    console.log()
  }

  // --- Benchmarks ---

  console.log("--- Single file, small change (1 line in 1 method) ---")
  {
    const { filePath, fileUri } = filePaths("src/entity.rs")
    const original = await readFile(filePath, "utf-8")
    const patched = original.replace(
      "if self.is_priest { 5 } else { 0 }",
      "if self.is_priest { 10 } else { 0 }",
    )
    const line = original.split("\n").findIndex((l) => l.includes("is_priest { 5 }"))

    await bench("entity.rs: 1-line change in get_strength_boost", () =>
      analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [{ start: line, end: line + 1 }],
        afterHunkRanges: [{ start: line, end: line + 1 }],
      }),
    )
  }

  console.log("--- Single file, new method (cross-file refs) ---")
  {
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

    await bench("tile.rs: new method with cross-file refs (Location)", () =>
      analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: patched,
        beforeHunkRanges: [],
        afterHunkRanges: [{ start: methodLine, end: methodLine + 4 }],
      }),
    )
  }

  console.log("--- Single file, large method (many symbols) ---")
  {
    const { filePath, fileUri } = filePaths("src/entity.rs")
    const original = await readFile(filePath, "utf-8")
    const lines = original.split("\n")
    // process_entity_turn is a big function — scan ~150 lines
    const fnLine = lines.findIndex((l) => l.includes("fn process_entity_turn"))
    const endLine = Math.min(fnLine + 150, lines.length)

    await bench(`entity.rs: process_entity_turn (${endLine - fnLine} lines)`, () =>
      analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: original,
        beforeHunkRanges: [{ start: fnLine, end: endLine }],
        afterHunkRanges: [{ start: fnLine, end: endLine }],
      }),
    )
  }

  console.log("--- Single file, entire Game struct ---")
  {
    const { filePath, fileUri } = filePaths("src/game.rs")
    const original = await readFile(filePath, "utf-8")
    const lines = original.split("\n")
    const structLine = lines.findIndex((l) => l.includes("pub struct Game"))

    await bench("game.rs: Game struct (all fields)", () =>
      analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: original,
        beforeHunkRanges: [{ start: structLine, end: structLine + 7 }],
        afterHunkRanges: [{ start: structLine, end: structLine + 7 }],
      }),
    )
  }

  console.log("--- Multiple files (simulated multi-file diff) ---")
  {
    const entityPaths = filePaths("src/entity.rs")
    const gamePaths = filePaths("src/game.rs")
    const tilePaths = filePaths("src/tile.rs")

    const entityOrig = await readFile(entityPaths.filePath, "utf-8")
    const gameOrig = await readFile(gamePaths.filePath, "utf-8")
    const tileOrig = await readFile(tilePaths.filePath, "utf-8")

    const entityLine = entityOrig.split("\n").findIndex((l) => l.includes("is_priest { 5 }"))
    const gameLine = gameOrig.split("\n").findIndex((l) => l.includes("fn get_current_level"))
    const tileLine = tileOrig.split("\n").findIndex((l) => l.includes("walkable"))

    const start = Date.now()
    // Sequential (what we do now)
    const r1 = await analyze({
      conn, legend,
      filePath: entityPaths.filePath, fileUri: entityPaths.fileUri,
      originalContent: entityOrig, patchedContent: entityOrig,
      beforeHunkRanges: [{ start: entityLine, end: entityLine + 3 }],
      afterHunkRanges: [{ start: entityLine, end: entityLine + 3 }],
    })
    const r2 = await analyze({
      conn, legend,
      filePath: gamePaths.filePath, fileUri: gamePaths.fileUri,
      originalContent: gameOrig, patchedContent: gameOrig,
      beforeHunkRanges: [{ start: gameLine, end: gameLine + 3 }],
      afterHunkRanges: [{ start: gameLine, end: gameLine + 3 }],
    })
    const r3 = await analyze({
      conn, legend,
      filePath: tilePaths.filePath, fileUri: tilePaths.fileUri,
      originalContent: tileOrig, patchedContent: tileOrig,
      beforeHunkRanges: [{ start: tileLine, end: tileLine + 3 }],
      afterHunkRanges: [{ start: tileLine, end: tileLine + 3 }],
    })
    const seqMs = Date.now() - start
    const totalDefs = r1.length + r2.length + r3.length

    // Parallel (different files can run concurrently with our mutex)
    const start2 = Date.now()
    const [p1, p2, p3] = await Promise.all([
      analyze({
        conn, legend,
        filePath: entityPaths.filePath, fileUri: entityPaths.fileUri,
        originalContent: entityOrig, patchedContent: entityOrig,
        beforeHunkRanges: [{ start: entityLine, end: entityLine + 3 }],
        afterHunkRanges: [{ start: entityLine, end: entityLine + 3 }],
      }),
      analyze({
        conn, legend,
        filePath: gamePaths.filePath, fileUri: gamePaths.fileUri,
        originalContent: gameOrig, patchedContent: gameOrig,
        beforeHunkRanges: [{ start: gameLine, end: gameLine + 3 }],
        afterHunkRanges: [{ start: gameLine, end: gameLine + 3 }],
      }),
      analyze({
        conn, legend,
        filePath: tilePaths.filePath, fileUri: tilePaths.fileUri,
        originalContent: tileOrig, patchedContent: tileOrig,
        beforeHunkRanges: [{ start: tileLine, end: tileLine + 3 }],
        afterHunkRanges: [{ start: tileLine, end: tileLine + 3 }],
      }),
    ])
    const parMs = Date.now() - start2

    console.log(`  3 files sequential: ${seqMs}ms (${totalDefs} definitions)`)
    console.log(`  3 files parallel:   ${parMs}ms (${p1.length + p2.length + p3.length} definitions)`)
    console.log(`  speedup: ${(seqMs / parMs).toFixed(1)}x`)
    console.log()
  }

  console.log("--- Cold open (first time touching a file) ---")
  {
    const { filePath, fileUri } = filePaths("src/astar.rs")
    const original = await readFile(filePath, "utf-8")
    const lines = original.split("\n")
    // Find a function in astar.rs
    const fnLine = lines.findIndex((l) => l.includes("pub fn ") || l.includes("fn "))

    if (fnLine >= 0) {
      const start = Date.now()
      const result = await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: original,
        beforeHunkRanges: [{ start: fnLine, end: fnLine + 10 }],
        afterHunkRanges: [{ start: fnLine, end: fnLine + 10 }],
      })
      const coldMs = Date.now() - start

      // Second call (warm)
      const start2 = Date.now()
      await analyze({
        conn, legend, filePath, fileUri,
        originalContent: original, patchedContent: original,
        beforeHunkRanges: [{ start: fnLine, end: fnLine + 10 }],
        afterHunkRanges: [{ start: fnLine, end: fnLine + 10 }],
      })
      const warmMs = Date.now() - start2

      console.log(`  astar.rs cold open: ${coldMs}ms (${result.length} defs)`)
      console.log(`  astar.rs warm:      ${warmMs}ms`)
      console.log()
    }
  }

  // Cleanup
  conn.end()
  conn.dispose()
  proc.kill()
  await rm(sandboxDir, { recursive: true, force: true }).catch(() => {})

  console.log("Done!")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
