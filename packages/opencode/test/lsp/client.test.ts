import { describe, expect, test, beforeEach } from "bun:test"
import path from "path"
import { LSPClient } from "../../src/lsp/client"
import { LSPServer } from "../../src/lsp/server"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

// Minimal fake LSP server that speaks JSON-RPC over stdio
function spawnFakeServer() {
  const { spawn } = require("child_process")
  const serverPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
  return {
    process: spawn(process.execPath, [serverPath], {
      stdio: "pipe",
    }),
  }
}

describe("LSPClient interop", () => {
  beforeEach(async () => {
    await Log.init({ print: true })
  })

  test("handles workspace/workspaceFolders request", async () => {
    const handle = spawnFakeServer() as any

    const client = await Instance.provide({
      directory: process.cwd(),
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "workspace/workspaceFolders",
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(client.connection).toBeDefined()

    await client.shutdown()
  })

  test("handles client/registerCapability request", async () => {
    const handle = spawnFakeServer() as any

    const client = await Instance.provide({
      directory: process.cwd(),
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "client/registerCapability",
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(client.connection).toBeDefined()

    await client.shutdown()
  })

  test("handles client/unregisterCapability request", async () => {
    const handle = spawnFakeServer() as any

    const client = await Instance.provide({
      directory: process.cwd(),
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "client/unregisterCapability",
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(client.connection).toBeDefined()

    await client.shutdown()
  })

  test("whenNextProgress resolves on a report event and msSinceLastProgress drops", async () => {
    const handle = spawnFakeServer() as any

    const client = await Instance.provide({
      directory: process.cwd(),
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
        }),
    })

    // No progress seen yet.
    expect(client.msSinceLastProgress()).toBe(Infinity)

    // Register the waiter, then drive a "report" (not begin/end) — the heartbeat
    // must fire for report, which today's begin/end-only handler ignores.
    const next = client.whenNextProgress()
    await client.connection.sendNotification("test/progress", { token: "t1", kind: "report" })
    await next

    expect(client.msSinceLastProgress()).toBeLessThan(5000)

    await client.shutdown()
  }, 30_000)

  test("experimental/serverStatus updates isQuiescent/hasSeenServerStatus and whenServerStatus resolves", async () => {
    const handle = spawnFakeServer() as any

    const client = await Instance.provide({
      directory: process.cwd(),
      fn: () =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
        }),
    })

    // No serverStatus seen yet.
    expect(client.hasSeenServerStatus()).toBe(false)
    expect(client.isQuiescent()).toBe(false)

    const first = client.whenServerStatus()
    await client.connection.sendNotification("test/server-status", { quiescent: false })
    await first
    expect(client.hasSeenServerStatus()).toBe(true)
    expect(client.isQuiescent()).toBe(false)

    const second = client.whenServerStatus()
    await client.connection.sendNotification("test/server-status", { quiescent: true })
    await second
    expect(client.isQuiescent()).toBe(true)

    await client.shutdown()
  }, 30_000)
})
