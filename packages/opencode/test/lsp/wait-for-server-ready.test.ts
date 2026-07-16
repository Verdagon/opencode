import { describe, expect, test, beforeEach } from "bun:test"
import path from "path"
import { LSPClient } from "../../src/lsp/client"
import { LSPServer } from "../../src/lsp/server"
import { ContextDefs } from "../../src/lsp/context-defs"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

function spawnFakeServer() {
  const { spawn } = require("child_process")
  const serverPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
  return { process: spawn(process.execPath, [serverPath], { stdio: "pipe" }) }
}

async function makeClient() {
  const handle = spawnFakeServer() as any
  return Instance.provide({
    directory: process.cwd(),
    fn: () =>
      LSPClient.create({
        serverID: "fake",
        server: handle as unknown as LSPServer.Handle,
        root: process.cwd(),
      }),
  })
}

function progress(client: any, kind: "begin" | "report" | "end", token = "t1") {
  return client.connection.sendNotification("test/progress", { token, kind })
}

async function serverStatus(client: any, quiescent: boolean) {
  const seen = client.whenServerStatus()
  await client.connection.sendNotification("test/server-status", { quiescent })
  await seen
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("waitForServerReady silence-watchdog", () => {
  beforeEach(async () => {
    await Log.init({ print: false })
  })

  test("resolves once the server goes idle (begin then end)", async () => {
    const client = await makeClient()
    const ready = ContextDefs.waitForServerReady(client, 5000)
    await progress(client, "begin")
    await progress(client, "end")
    await ready // must resolve, not throw
    await client.shutdown()
  }, 30_000)

  test("stays pending while report events flow past the silence budget, then resolves on end", async () => {
    const client = await makeClient()
    // silence budget is 600ms; reports arrive every 150ms so silence is never reached.
    // The old flat-timeout impl would reject at 600ms regardless of reports.
    const ready = ContextDefs.waitForServerReady(client, 600)
    await progress(client, "begin")
    for (let i = 0; i < 6; i++) {
      await progress(client, "report")
      await sleep(150)
    }
    await progress(client, "end")
    await ready // resolves only if reports kept the watchdog alive
    await client.shutdown()
  }, 30_000)

  test("rejects as wedged after the silence budget with no progress and not idle", async () => {
    const client = await makeClient()
    await progress(client, "begin") // non-idle, but no further progress and never ends
    await sleep(50)
    await expect(ContextDefs.waitForServerReady(client, 300)).rejects.toThrow(/wedged/)
    await client.shutdown()
  }, 30_000)

  test("gates on quiescent: a transient idle does not resolve; resolves when quiescent flips true", async () => {
    const client = await makeClient()
    // Establish that this server supports serverStatus and is currently non-quiescent.
    await serverStatus(client, false)

    let resolved = false
    const ready = ContextDefs.waitForServerReady(client, 5000).then(() => {
      resolved = true
    })

    // A transient inter-phase idle (begin then end) must NOT be treated as ready while the
    // authoritative quiescent flag is still false — this is the bug the whole change fixes.
    await progress(client, "begin")
    await progress(client, "end")
    await sleep(300)
    expect(resolved).toBe(false)

    // Only the quiescent signal marks readiness.
    await serverStatus(client, true)
    await ready
    expect(resolved).toBe(true)

    await client.shutdown()
  }, 30_000)

  test("rejects as wedged when serverStatus stays non-quiescent with no progress", async () => {
    const client = await makeClient()
    await serverStatus(client, false) // supported, not quiescent, and no further signals
    await expect(ContextDefs.waitForServerReady(client, 300)).rejects.toThrow(/wedged/)
    await client.shutdown()
  }, 30_000)

  test("fast-path resolves immediately when already idle", async () => {
    const client = await makeClient()
    await progress(client, "begin")
    await progress(client, "end")
    await sleep(50) // let idle state settle
    const start = Date.now()
    await ContextDefs.waitForServerReady(client, 5000)
    expect(Date.now() - start).toBeLessThan(200)
    await client.shutdown()
  }, 30_000)
})
