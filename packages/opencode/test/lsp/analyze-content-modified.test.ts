import { describe, expect, test, beforeEach } from "bun:test"
import { ContextDefs } from "../../src/lsp/context-defs"
import { Log } from "../../src/util/log"

describe("analyzeFile: -32801 ContentModified deadline reset", () => {
  beforeEach(async () => {
    await Log.init({ print: false })
  })

  test("survives more than 6 consecutive ContentModified errors, then resolves", async () => {
    // rust-analyzer throws -32801 (ContentModified) while it reanalyzes a pushed didChange.
    // The old fixed 6-attempt budget threw "after N attempts" on a cold crate; the deadline must
    // instead RESET on each -32801 (proof RA is actively working) and keep retrying until tokens.
    let calls = 0
    const THRESHOLD = 12 // > 6 attempts * 2 sendRequests per attempt — old code can't get past this
    const conn = {
      sendNotification: async () => {},
      sendRequest: async (method: string) => {
        calls++
        if (calls <= THRESHOLD) {
          const err: any = new Error("content modified")
          err.code = -32801
          throw err
        }
        if (method === "textDocument/documentSymbol") return []
        if (method === "textDocument/semanticTokens/full") return { data: [0, 0, 1, 1, 0] }
        return null
      },
    }

    const legend: ContextDefs.Legend = { tokenTypes: [], tokenModifiers: [] }
    const { definitions, errors } = await ContextDefs.analyzeFile({
      conn,
      legend,
      filePath: "/tmp/warm/fake.rs",
      fileUri: "file:///tmp/warm/fake.rs",
      originalContent: "",
      patchedContent: "fn main() {}\n",
      beforeHunkRanges: [],
      afterHunkRanges: [{ start: 0, end: 1 }],
    })

    expect(errors).toEqual([])
    expect(definitions).toEqual([])
    expect(calls).toBeGreaterThan(THRESHOLD)
  }, 30_000)
})
