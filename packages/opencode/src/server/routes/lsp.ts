import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { ContextDefs } from "../../lsp/context-defs"
import { LSP } from "../../lsp"
import type { LSPClient } from "../../lsp/client"
import { Instance } from "../../project/instance"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import path from "path"
import { pathToFileURL } from "url"
import { readFileSync } from "fs"

const SymbolDefinitionSchema = z
  .object({
    symbol: z.string(),
    tokenType: z.string(),
    definedIn: z.object({
      path: z.string(),
      line: z.number(),
      character: z.number(),
      endLine: z.number().nullable(),
      endCharacter: z.number().nullable(),
    }),
    usedAt: z.object({
      path: z.string(),
      line: z.number(),
      character: z.number(),
    }),
    definitionText: z.string().nullable(),
    docComment: z.string().nullable(),
  })
  .meta({ ref: "SymbolDefinition" })

const ContextDefsResultSchema = z
  .object({
    definitions: z.array(SymbolDefinitionSchema),
    errors: z.array(z.string()),
  })
  .meta({ ref: "ContextDefsResult" })

// Track which clients have been waited on for initial indexing
const readyClients = new WeakSet<object>()

/**
 * Create a ContentPusher that uses the LSPClient's notify.change method,
 * coordinating with the client's own file tracking state.
 */
function clientContentPusher(client: LSPClient.Info): ContextDefs.ContentPusher {
  return async (filePath: string, content: string) => {
    await client.notify.change({ path: filePath, content })
  }
}

export const LspRoutes = lazy(() =>
  new Hono().post(
    "/context-defs",
    describeRoute({
      summary: "Analyze diff context definitions",
      description:
        "Given a unified diff, identify all symbols referenced in the affected code regions and resolve them to their definition locations.",
      operationId: "lsp.contextDefs",
      responses: {
        200: {
          description: "Symbol definitions referenced by the diff",
          content: {
            "application/json": {
              schema: resolver(ContextDefsResultSchema),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        diff: z.string().describe("A unified diff string"),
      }),
    ),
    async (c) => {
      const { diff } = c.req.valid("json")
      const projectRoot = Instance.directory

      if (!diff.trim()) {
        return c.json({ definitions: [], errors: [] })
      }

      const parsedFiles = ContextDefs.parseUnifiedDiff(diff)
      const allDefinitions: ContextDefs.SymbolDefinition[] = []
      const errs: string[] = []

      for (const fileDiff of parsedFiles) {
        const filePath = path.resolve(projectRoot, fileDiff.path)
        const fileUri = pathToFileURL(filePath).href

        try {
          const clients = await LSP.clientsForFile(filePath)
          if (clients.length === 0) {
            errs.push(`${fileDiff.path}: no LSP server available`)
            continue
          }

          const client = clients.find((c) => c.legend) ?? clients[0]
          if (!client.legend) {
            errs.push(`${fileDiff.path}: LSP server does not support semantic tokens`)
            continue
          }

          // Wait for initial indexing on first use of this client
          if (!readyClients.has(client)) {
            await ContextDefs.waitForServerReady(client.connection, 10000)
            readyClients.add(client)
          }

          // Read current file from disk
          let diskContent: string
          try {
            diskContent = readFileSync(filePath, "utf-8")
          } catch {
            if (fileDiff.isNew) {
              diskContent = ""
            } else {
              errs.push(`${fileDiff.path}: file not found`)
              continue
            }
          }

          // Determine original and patched content
          let originalContent: string
          let patchedContent: string

          if (fileDiff.isNew) {
            originalContent = ""
            patchedContent = diskContent
          } else if (fileDiff.isDeleted) {
            originalContent = diskContent
            patchedContent = ""
          } else {
            const singleDiff = extractSingleFileDiff(diff, fileDiff.path)
            try {
              const applied = ContextDefs.applyDiff(diskContent, singleDiff)
              originalContent = diskContent
              patchedContent = applied
            } catch {
              errs.push(`${fileDiff.path}: could not apply diff`)
              continue
            }
          }

          const beforeHunkRanges = fileDiff.hunks.map((h) => ({
            start: h.oldStart,
            end: h.oldStart + h.oldLines,
          }))
          const afterHunkRanges = fileDiff.hunks.map((h) => ({
            start: h.newStart,
            end: h.newStart + h.newLines,
          }))

          const result = await ContextDefs.analyzeFile({
            conn: client.connection,
            legend: client.legend,
            filePath,
            fileUri,
            originalContent,
            patchedContent,
            beforeHunkRanges,
            afterHunkRanges,
            pushContent: clientContentPusher(client),
          })

          allDefinitions.push(...result.definitions)
          errs.push(...result.errors)
        } catch (err: any) {
          errs.push(`${fileDiff.path}: ${err.message ?? err}`)
        }
      }

      // Deduplicate
      const seen = new Set<string>()
      const deduped = allDefinitions.filter((def) => {
        const key = `${def.symbol}:${def.definedIn.path}:${def.definedIn.line}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      return c.json({ definitions: deduped, errors: errs })
    },
  ),
)

/**
 * Extract a single file's diff from a multi-file diff string.
 * Handles both "diff --git" format and plain "---/+++" format.
 * Returns the full diff if the file can't be found (single-file diff).
 */
function extractSingleFileDiff(fullDiff: string, filePath: string): string {
  const lines = fullDiff.split("\n")
  let inFile = false
  const result: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith("diff --git ") && line.includes(filePath)) {
      inFile = true
      result.push(line)
    } else if (line.startsWith("diff --git ") && inFile) {
      break
    } else if (!inFile && line.startsWith("--- ") && line.includes(filePath)) {
      inFile = true
      result.push(line)
    } else if (inFile && line.startsWith("--- ") && !line.includes(filePath)) {
      break
    } else if (inFile) {
      result.push(line)
    }
  }

  // Single-file diff that doesn't match our patterns — return as-is
  if (result.length === 0) {
    return fullDiff
  }

  return result.join("\n") + "\n"
}
