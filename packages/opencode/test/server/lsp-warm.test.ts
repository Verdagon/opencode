/**
 * End-to-end tests for POST /lsp/warm through the actual Hono server.
 * Warming spawns rust-analyzer for the project and returns once it reaches idle,
 * so a later context-defs request never pays the cold-start.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { cp } from "fs/promises"
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

describe("POST /lsp/warm", () => {
  test("returns 503 unavailable when no LSP server handles the path's extension", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()

    try {
      const res = await app.request("/lsp/warm", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-opencode-directory": tmp.path },
        body: JSON.stringify({ path: "__warm__.xyz" }),
      })

      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.status).toBe("unavailable")
    } finally {
      await Instance.disposeAll()
    }
  })

  test("returns 200 ready after spawning rust-analyzer for a Rust crate", async () => {
    await using tmp = await tmpdir({ git: true })
    await cp(FIXTURE, tmp.path, { recursive: true })
    const app = Server.Default()

    try {
      const res = await app.request("/lsp/warm", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-opencode-directory": tmp.path },
        body: JSON.stringify({ path: "__warm__.rs" }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe("ready")
    } finally {
      await Instance.disposeAll()
    }
  }, 120_000)
})
