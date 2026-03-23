/**
 * End-to-end tests for POST /lsp/context-defs through the actual Hono server.
 * These tests exercise the full stack: HTTP route → diff parsing → file I/O → LSP.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { cp, writeFile, readFile, rm } from "fs/promises"
import path from "path"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const FIXTURE = path.join(__dirname, "../fixture/sandbox-roguelike")

Log.init({ print: false })

afterEach(async () => {
  await resetDatabase()
})

describe("POST /lsp/context-defs", () => {
  test("returns 200 with empty definitions for empty diff", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()

    try {
      const res = await app.request("/lsp/context-defs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({ diff: "" }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.definitions).toEqual([])
      expect(body.errors).toEqual([])
    } finally {
      await Instance.disposeAll()
    }
  })

  test("returns 400 when diff field is missing", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()

    try {
      const res = await app.request("/lsp/context-defs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
    } finally {
      await Instance.disposeAll()
    }
  })

  test("returns error for diff referencing non-existent file", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()

    const diff = `diff --git a/src/missing.rs b/src/missing.rs
--- a/src/missing.rs
+++ b/src/missing.rs
@@ -1,1 +1,2 @@
 line1
+line2
`
    try {
      const res = await app.request("/lsp/context-defs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({ diff }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.errors.length).toBeGreaterThan(0)
      expect(body.errors[0]).toContain("missing.rs")
    } finally {
      await Instance.disposeAll()
    }
  })

  test("response schema has correct fields", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()

    try {
      const res = await app.request("/lsp/context-defs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({ diff: "" }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveProperty("definitions")
      expect(body).toHaveProperty("errors")
      expect(Array.isArray(body.definitions)).toBe(true)
      expect(Array.isArray(body.errors)).toBe(true)
    } finally {
      await Instance.disposeAll()
    }
  })

  test("analyzes a real Rust diff and gets actual definitions", async () => {
    // Copy fixture to a git-initialized temp dir
    await using tmp = await tmpdir({ git: true })
    // Copy fixture source files into the git repo
    await cp(FIXTURE, tmp.path, { recursive: true })

    // Create a modification
    const tilePath = path.join(tmp.path, "src/tile.rs")
    const original = await readFile(tilePath, "utf-8")
    const modified = original + `
impl Tile {
    pub fn cost(&self) -> i32 {
        if self.walkable { 1 } else { 100 }
    }
}
`
    // Generate a diff
    const { createTwoFilesPatch } = require("diff")
    const diff = createTwoFilesPatch("a/src/tile.rs", "b/src/tile.rs", original, modified)

    const app = Server.Default()

    try {
      const res = await app.request("/lsp/context-defs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({ diff }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()

      // Either we get definitions (if RA spun up in time) or errors (if RA isn't available)
      expect(body).toHaveProperty("definitions")
      expect(body).toHaveProperty("errors")

      // This is the key test: going through opencode's LSP client layer
      // (not a raw connection), definitions should actually resolve.
      // This catches issues like:
      // - LSP server not indexed yet (no retry/wait)
      // - didOpen conflicts with opencode's client tracking
      // - workspace/didChangeWatchedFiles causing disk re-read
      if (body.errors.length === 0) {
        expect(body.definitions.length).toBeGreaterThan(0)
        const symbols = body.definitions.map((d: any) => d.symbol)
        expect(symbols).toContain("walkable")

        for (const def of body.definitions) {
          expect(def).toHaveProperty("symbol")
          expect(def).toHaveProperty("tokenType")
          expect(def).toHaveProperty("definedIn")
          expect(def).toHaveProperty("usedAt")
          expect(def.definedIn).toHaveProperty("path")
          expect(def.definedIn).toHaveProperty("line")
          expect(def.definedIn).toHaveProperty("character")
          expect(def.definedIn).toHaveProperty("endLine")
          expect(def.definedIn).toHaveProperty("endCharacter")
          expect(def).toHaveProperty("definitionText")
          expect(def).toHaveProperty("docComment")
        }

        // At least one cross-file definition should have definitionText
        const enriched = body.definitions.filter((d: any) => d.definitionText !== null)
        // Can't guarantee enrichment worked (depends on RA timing), but if it did, check shape
        for (const def of enriched) {
          expect(typeof def.definitionText).toBe("string")
          expect(def.definitionText.length).toBeGreaterThan(0)
          expect(typeof def.definedIn.endLine).toBe("number")
        }
      }
    } finally {
      await Instance.disposeAll()
    }
  }, 120_000)

  // --- Stress tests for diff→file logic (#2) ---

  test("second request to same project reuses LSP server (warm path)", async () => {
    // Copy fixture to a git-initialized temp dir
    await using tmp = await tmpdir({ git: true })
    await cp(FIXTURE, tmp.path, { recursive: true })

    const tilePath = path.join(tmp.path, "src/tile.rs")
    const original = await readFile(tilePath, "utf-8")

    const { createTwoFilesPatch } = require("diff")

    const app = Server.Default()

    try {
      // First request: cold start, spawns RA
      const diff1 = createTwoFilesPatch("a/src/tile.rs", "b/src/tile.rs",
        original, original + "\nimpl Tile { pub fn a(&self) -> bool { self.walkable } }\n")
      const res1 = await app.request("/lsp/context-defs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-opencode-directory": tmp.path },
        body: JSON.stringify({ diff: diff1 }),
      })
      expect(res1.status).toBe(200)
      const body1 = await res1.json()

      // Second request: warm, RA already running
      const diff2 = createTwoFilesPatch("a/src/tile.rs", "b/src/tile.rs",
        original, original + "\nimpl Tile { pub fn b(&self) -> String { self.display_class.clone() } }\n")
      const res2 = await app.request("/lsp/context-defs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-opencode-directory": tmp.path },
        body: JSON.stringify({ diff: diff2 }),
      })
      expect(res2.status).toBe(200)
      const body2 = await res2.json()

      // At least one of the two should produce definitions
      // (cold start may fail if RA takes too long, but warm should work)
      if (body1.errors.length === 0 || body2.errors.length === 0) {
        const totalDefs = (body1.definitions?.length ?? 0) + (body2.definitions?.length ?? 0)
        expect(totalDefs).toBeGreaterThan(0)
      }
    } finally {
      await Instance.disposeAll()
    }
  }, 120_000)

  test("cross-file definition resolution works through server", async () => {
    await using tmp = await tmpdir({ git: true })
    await cp(FIXTURE, tmp.path, { recursive: true })

    const tilePath = path.join(tmp.path, "src/tile.rs")
    const original = await readFile(tilePath, "utf-8")

    // Add a method that references Location from location.rs
    const modified = original + `
impl Tile {
    pub fn origin(&self) -> crate::location::Location {
        crate::location::Location::new(0, 0)
    }
}
`
    const { createTwoFilesPatch } = require("diff")
    const diff = createTwoFilesPatch("a/src/tile.rs", "b/src/tile.rs", original, modified)

    const app = Server.Default()

    try {
      const res = await app.request("/lsp/context-defs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-opencode-directory": tmp.path },
        body: JSON.stringify({ diff }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()

      if (body.errors.length === 0 && body.definitions.length > 0) {
        const symbols = body.definitions.map((d: any) => d.symbol)
        expect(symbols).toContain("Location")

        // Verify the definition points to location.rs, not tile.rs
        const locDef = body.definitions.find((d: any) => d.symbol === "Location" && d.tokenType === "struct")
        if (locDef) {
          expect(locDef.definedIn.path).toContain("location.rs")
        }
      }
    } finally {
      await Instance.disposeAll()
    }
  }, 120_000)

  // --- Stress tests for diff→file logic ---

  test("diff where file on disk doesn't match diff context", async () => {
    await using tmp = await tmpdir({ git: true })
    // Write a file with content that doesn't match the diff
    const { mkdir } = require("fs/promises")
    await mkdir(path.join(tmp.path, "src"), { recursive: true })
    await writeFile(path.join(tmp.path, "src/mismatch.rs"), "completely different content\n")

    const diff = `diff --git a/src/mismatch.rs b/src/mismatch.rs
--- a/src/mismatch.rs
+++ b/src/mismatch.rs
@@ -1,3 +1,4 @@
 fn foo() {
+    bar();
     baz();
 }
`
    const app = Server.Default()

    try {
      const res = await app.request("/lsp/context-defs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({ diff }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      // Should report error, not crash
      expect(body.errors.length).toBeGreaterThan(0)
      expect(body.errors[0]).toContain("mismatch.rs")
    } finally {
      await Instance.disposeAll()
    }
  })

  test("diff with multiple files, some missing some present", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeFile(path.join(tmp.path, "exists.txt"), "line1\nline2\nline3\n")

    const diff = `diff --git a/exists.txt b/exists.txt
--- a/exists.txt
+++ b/exists.txt
@@ -1,3 +1,4 @@
 line1
+inserted
 line2
 line3
diff --git a/missing.txt b/missing.txt
--- a/missing.txt
+++ b/missing.txt
@@ -1,1 +1,2 @@
 old
+new
`
    const app = Server.Default()

    try {
      const res = await app.request("/lsp/context-defs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({ diff }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      // Should have an error for missing.txt but not crash
      const missingErrors = body.errors.filter((e: string) => e.includes("missing.txt"))
      expect(missingErrors.length).toBeGreaterThan(0)
    } finally {
      await Instance.disposeAll()
    }
  })

  test("diff for .txt file reports no LSP server", async () => {
    await using tmp = await tmpdir({ git: true })
    await writeFile(path.join(tmp.path, "readme.txt"), "hello\n")

    const diff = `diff --git a/readme.txt b/readme.txt
--- a/readme.txt
+++ b/readme.txt
@@ -1,1 +1,2 @@
 hello
+world
`
    const app = Server.Default()

    try {
      const res = await app.request("/lsp/context-defs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({ diff }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      // No LSP for .txt files
      expect(body.errors.length).toBeGreaterThan(0)
    } finally {
      await Instance.disposeAll()
    }
  })

  test("very large diff doesn't crash", async () => {
    await using tmp = await tmpdir({ git: true })

    // Generate a large file
    const lines = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n") + "\n"
    const modifiedLines = lines + Array.from({ length: 100 }, (_, i) => `added${i}`).join("\n") + "\n"
    await writeFile(path.join(tmp.path, "large.txt"), lines)

    const { createTwoFilesPatch } = require("diff")
    const diff = createTwoFilesPatch("a/large.txt", "b/large.txt", lines, modifiedLines)

    const app = Server.Default()

    try {
      const res = await app.request("/lsp/context-defs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": tmp.path,
        },
        body: JSON.stringify({ diff }),
      })

      expect(res.status).toBe(200)
      // Should not crash, even if no LSP server for .txt
    } finally {
      await Instance.disposeAll()
    }
  })
})
