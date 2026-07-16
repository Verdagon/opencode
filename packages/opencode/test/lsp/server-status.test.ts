/**
 * Real-rust-analyzer proof that the experimental/serverStatus capability is advertised and its
 * notifications are received: a fresh rust-analyzer, once it finishes indexing, reports
 * quiescent=true, and the client tracks it. Guards against silently dropping the capability
 * (which would send us back to the transient-idle heuristic). Needs `rust-analyzer` on PATH.
 */
import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import { mkdtemp, cp, rm } from "fs/promises"
import path from "path"
import os from "os"
import { LSPClient } from "../../src/lsp/client"
import { LSPServer } from "../../src/lsp/server"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

const FIXTURE = path.join(__dirname, "../fixture/sandbox-roguelike")
Log.init({ print: false })

describe("experimental/serverStatus with real rust-analyzer", () => {
  test("real rust-analyzer reports quiescent via serverStatus", async () => {
    const sandboxDir = await mkdtemp(path.join(os.tmpdir(), "opencode-serverstatus-"))
    await cp(FIXTURE, sandboxDir, { recursive: true })
    const proc = spawn("rust-analyzer", [], { cwd: sandboxDir, stdio: "pipe" })

    try {
      const client = await Instance.provide({
        directory: sandboxDir,
        fn: () =>
          LSPClient.create({
            serverID: "rust",
            server: {
              process: proc,
              initialization: { procMacro: { enable: false } },
            } as unknown as LSPServer.Handle,
            root: sandboxDir,
          }),
      })

      // Wait explicitly for quiescent (independent of waitForServerReady's semantics), so this
      // test proves only: capability advertised -> RA emits serverStatus -> quiescent reached.
      const deadline = Date.now() + 90_000
      while (!client.isQuiescent() && Date.now() < deadline) {
        await Promise.race([client.whenServerStatus(), new Promise((r) => setTimeout(r, 1000))])
      }

      expect(client.hasSeenServerStatus()).toBe(true)
      expect(client.isQuiescent()).toBe(true)

      await client.shutdown()
    } finally {
      proc.kill()
      await rm(sandboxDir, { recursive: true, force: true }).catch(() => {})
    }
  }, 120_000)
})
