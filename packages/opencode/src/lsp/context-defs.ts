import { pathToFileURL } from "url"
import { LANGUAGE_EXTENSIONS } from "./language"

export namespace ContextDefs {
  export interface SemanticToken {
    line: number
    startChar: number
    length: number
    tokenType: string
    modifiers: string[]
  }

  export interface Legend {
    tokenTypes: string[]
    tokenModifiers: string[]
  }

  export function decodeSemanticTokens(data: number[], legend: Legend): SemanticToken[] {
    if (data.length % 5 !== 0) {
      throw new Error(`Semantic token data length ${data.length} is not a multiple of 5`)
    }

    const tokens: SemanticToken[] = []
    let currentLine = 0
    let currentChar = 0

    for (let i = 0; i < data.length; i += 5) {
      const deltaLine = data[i]
      const deltaStartChar = data[i + 1]
      const length = data[i + 2]
      const tokenTypeIdx = data[i + 3]
      const tokenModBits = data[i + 4]

      if (deltaLine > 0) {
        currentLine += deltaLine
        currentChar = deltaStartChar
      } else {
        currentChar += deltaStartChar
      }

      const modifiers: string[] = []
      for (let bit = 0; bit < legend.tokenModifiers.length; bit++) {
        if (tokenModBits & (1 << bit)) {
          modifiers.push(legend.tokenModifiers[bit])
        }
      }

      tokens.push({
        line: currentLine,
        startChar: currentChar,
        length,
        tokenType: legend.tokenTypes[tokenTypeIdx] ??
          (() => { throw new Error(`Semantic token type index ${tokenTypeIdx} out of range (legend has ${legend.tokenTypes.length} types)`) })(),
        modifiers,
      })
    }

    return tokens
  }

  const INTERESTING_TOKEN_TYPES = new Set([
    "function",
    "method",
    "variable",
    "property",
    "struct",
    "enum",
    "type",
    "interface",
    "parameter",
    "namespace",
    "enumMember",
    "macro",
    "typeAlias",
    "union",
    "trait",
    "const",
    "constParameter",
    "typeParameter",
    "procMacro",
    "derive",
  ])

  export function filterInterestingTokens(tokens: SemanticToken[]): SemanticToken[] {
    return tokens.filter((t) => INTERESTING_TOKEN_TYPES.has(t.tokenType))
  }

  export function extractSymbolText(token: SemanticToken, fileContent: string): string {
    const lines = fileContent.split("\n")
    const line = lines[token.line]
    if (line === undefined) {
      throw new Error(
        `Token at line ${token.line} is beyond file content (${lines.length} lines)`,
      )
    }
    return line.substring(token.startChar, token.startChar + token.length)
  }

  // --- Doc comment and definition text extraction ---

  // Extract doc comments above a definition.
  // Collects ///, //, and doc block comments. Does NOT collect non-doc block comments.
  // Walks backwards from defStartLine - 1, stopping at non-comment/non-blank lines.
  export function extractDocComment(lines: string[], defStartLine: number): string | null {
    if (defStartLine <= 0) return null

    const collected: string[] = []
    let i = defStartLine - 1

    while (i >= 0) {
      const line = lines[i]
      const trimmed = line.trimStart()

      // Blank line — include it (might be between comment lines) but peek ahead
      // to check if there are more comments above
      if (trimmed === "") {
        // Check if there's a comment above this blank line
        let hasCommentAbove = false
        for (let j = i - 1; j >= 0; j--) {
          const above = lines[j].trimStart()
          if (above === "") continue
          if (above.startsWith("///") || above.startsWith("//") || above.endsWith("*/")) {
            hasCommentAbove = true
          }
          break
        }
        if (hasCommentAbove) {
          collected.push(line)
          i--
          continue
        }
        break
      }

      // Single-line // or /// comment
      if (trimmed.startsWith("//")) {
        collected.push(line)
        i--
        continue
      }

      // End of a block comment — scan backwards for the opening
      if (trimmed.endsWith("*/")) {
        // Find the opening line
        const blockEnd = i
        let blockStart = i
        while (blockStart >= 0) {
          const blockLine = lines[blockStart].trimStart()
          if (blockLine.startsWith("/**") || blockLine.startsWith("/*")) {
            break
          }
          blockStart--
        }

        if (blockStart >= 0) {
          const opener = lines[blockStart].trimStart()
          if (opener.startsWith("/**")) {
            // Doc block comment — collect in reverse order (will be reversed later)
            for (let j = blockEnd; j >= blockStart; j--) {
              collected.push(lines[j])
            }
            i = blockStart - 1
            continue
          }
        }

        // Non-doc block comment (/* ... */) — stop
        break
      }

      // Any other line — stop
      break
    }

    if (collected.length === 0) return null

    collected.reverse()
    return collected.join("\n")
  }

  /**
   * Extract the full text of a definition given its start and end lines.
   */
  export function extractDefinitionText(
    lines: string[],
    startLine: number,
    endLine: number,
  ): string {
    if (startLine > endLine) return ""
    const end = Math.min(endLine + 1, lines.length)
    return lines.slice(startLine, end).join("\n")
  }

  // --- Diff parsing ---

  export interface DiffHunk {
    oldStart: number // 0-based
    oldLines: number
    newStart: number // 0-based
    newLines: number
  }

  export interface ParsedFileDiff {
    path: string
    isNew: boolean
    isDeleted: boolean
    hunks: DiffHunk[]
  }

  export function parseUnifiedDiff(diff: string): ParsedFileDiff[] {
    const results: ParsedFileDiff[] = []

    // Normalize CRLF
    const normalized = diff.replace(/\r\n/g, "\n")
    const lines = normalized.split("\n")

    let i = 0
    while (i < lines.length) {
      const line = lines[i]

      if (line.startsWith("diff --git ")) {
        let oldPath: string | undefined
        let newPath: string | undefined
        let isNew = false
        let isDeleted = false
        const hunks: DiffHunk[] = []

        const gitMatch = line.match(/^diff --git a\/(.*?) b\/(.*)$/)
        if (gitMatch) {
          oldPath = gitMatch[1]
          newPath = gitMatch[2]
        }

        i++

        while (i < lines.length && !lines[i].startsWith("diff --git ")) {
          const cur = lines[i]

          if (cur.startsWith("new file")) {
            isNew = true
          } else if (cur.startsWith("deleted file")) {
            isDeleted = true
          } else if (cur.startsWith("rename to ")) {
            newPath = cur.slice("rename to ".length)
          } else if (cur.startsWith("--- ")) {
            const p = cur.slice(4)
            if (p === "/dev/null") {
              isNew = true
            } else {
              oldPath = stripPrefix(p)
            }
          } else if (cur.startsWith("+++ ")) {
            const p = cur.slice(4)
            if (p === "/dev/null") {
              isDeleted = true
            } else {
              newPath = stripPrefix(p)
            }
          } else if (cur.startsWith("@@ ")) {
            const hunk = parseHunkHeader(cur)
            if (hunk) hunks.push(hunk)
          }

          i++
        }

        const path = newPath ?? oldPath
        if (path && hunks.length > 0) {
          results.push({ path, isNew, isDeleted, hunks })
        }
        continue
      }

      // Handle non-git unified diffs (plain --- / +++ pairs)
      if (line.startsWith("--- ")) {
        let oldPath: string | undefined
        let newPath: string | undefined
        let isNew = false
        let isDeleted = false
        const hunks: DiffHunk[] = []

        const p = line.slice(4)
        if (p === "/dev/null") {
          isNew = true
        } else {
          oldPath = stripPrefix(p)
        }
        i++

        if (i < lines.length && lines[i].startsWith("+++ ")) {
          const p = lines[i].slice(4)
          if (p === "/dev/null") {
            isDeleted = true
          } else {
            newPath = stripPrefix(p)
          }
          i++
        }

        while (
          i < lines.length &&
          !lines[i].startsWith("diff --git ") &&
          !lines[i].startsWith("--- ")
        ) {
          if (lines[i].startsWith("@@ ")) {
            const hunk = parseHunkHeader(lines[i])
            if (hunk) hunks.push(hunk)
          }
          i++
        }

        const path = newPath ?? oldPath
        if (path && hunks.length > 0) {
          results.push({ path, isNew, isDeleted, hunks })
        }
        continue
      }

      i++
    }

    return results
  }

  function stripPrefix(p: string): string {
    if (p.startsWith("a/")) return p.slice(2)
    if (p.startsWith("b/")) return p.slice(2)
    return p
  }

  function parseHunkHeader(line: string): DiffHunk | null {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (!match) return null
    return {
      oldStart: parseInt(match[1], 10) - 1,
      oldLines: parseInt(match[2] ?? "1", 10),
      newStart: parseInt(match[3], 10) - 1,
      newLines: parseInt(match[4] ?? "1", 10),
    }
  }

  // --- Enclosing definition detection ---

  const ENCLOSING_SYMBOL_KINDS = new Set([
    5, // Class
    6, // Method
    10, // Enum
    11, // Interface
    12, // Function
    23, // Struct
  ])

  export interface NormalizedSymbol {
    name: string
    kind: number
    range: { start: { line: number }; end: { line: number } }
    children?: NormalizedSymbol[]
  }

  export function normalizeSymbols(symbols: any[]): NormalizedSymbol[] {
    if (symbols.length === 0) return []

    // Detect format: SymbolInformation has .location, DocumentSymbol has .range directly
    const hasLocation = symbols.some((s) => s.location)
    if (hasLocation) {
      return symbols
        .filter((s) => s.location?.range)
        .map((s) => ({
          name: s.name,
          kind: s.kind,
          range: s.location.range,
          containerName: s.containerName,
        }))
    }

    return symbols.map((s) => ({
      name: s.name,
      kind: s.kind,
      range: s.range,
      children: s.children ? normalizeSymbols(s.children) : undefined,
    }))
  }

  export function findEnclosingDefinitions(
    symbols: any[],
    hunkRanges: Array<{ start: number; end: number }>,
  ): NormalizedSymbol[] {
    if (hunkRanges.length === 0) return []

    const normalized = normalizeSymbols(symbols)
    const result: NormalizedSymbol[] = []
    const seen = new Set<string>()

    function addIfNew(sym: NormalizedSymbol) {
      const key = `${sym.name}:${sym.range.start.line}`
      if (!seen.has(key)) {
        seen.add(key)
        result.push(sym)
      }
    }

    function overlapsAnyHunk(sym: NormalizedSymbol): boolean {
      const symStart = sym.range.start.line
      const symEnd = sym.range.end.line
      return hunkRanges.some((hunk) => hunk.start <= symEnd && hunk.end >= symStart)
    }

    function walkNested(syms: NormalizedSymbol[]) {
      for (const sym of syms) {
        if (!overlapsAnyHunk(sym)) continue

        if (ENCLOSING_SYMBOL_KINDS.has(sym.kind)) {
          if (sym.children && sym.children.length > 0) {
            const before = result.length
            walkNested(sym.children)
            if (result.length > before) continue
          }
          addIfNew(sym)
        } else if (sym.children) {
          walkNested(sym.children)
        }
      }
    }

    const isFlat = normalized.every((s) => !s.children)

    if (isFlat) {
      for (const sym of normalized) {
        if (ENCLOSING_SYMBOL_KINDS.has(sym.kind) && overlapsAnyHunk(sym)) {
          addIfNew(sym)
        }
      }
    } else {
      walkNested(normalized)
    }

    return result
  }

  export function applyDiff(original: string, diff: string): string {
    const { applyPatch } = require("diff")
    const result = applyPatch(original, diff)
    if (result === false) {
      throw new Error("Failed to apply patch: context mismatch")
    }
    return result
  }

  // --- Result types ---

  export interface SymbolDefinition {
    symbol: string
    tokenType: string
    definedIn: {
      path: string
      line: number
      character: number
      endLine: number | null
      endCharacter: number | null
    }
    usedAt: {
      path: string
      line: number
      character: number
    }
    definitionText: string | null
    docComment: string | null
  }

  export interface ContextDefsResult {
    definitions: SymbolDefinition[]
    errors: string[]
  }

  // --- Definition resolution ---

  export interface DefinitionLocation {
    uri: string
    line: number
    character: number
    endLine: number
    endCharacter: number
  }

  export function normalizeDefinitionResponse(result: any): DefinitionLocation[] {
    if (!result) return []
    const items = Array.isArray(result) ? result : [result]
    const locs: DefinitionLocation[] = []
    for (const item of items) {
      if (!item) continue
      const uri = item.uri ?? item.targetUri
      const range = item.range ?? item.targetRange
      if (uri && range) {
        locs.push({
          uri,
          line: range.start.line,
          character: range.start.character,
          endLine: range.end.line,
          endCharacter: range.end.character,
        })
      }
    }
    return locs
  }

  export async function resolveTokenDefinitions(input: {
    conn: any
    fileUri: string
    filePath: string
    fileContent: string
    tokens: SemanticToken[]
    enclosingDefs: NormalizedSymbol[]
    legend: Legend
  }): Promise<SymbolDefinition[]> {
    const { conn, fileUri, filePath, fileContent, tokens, enclosingDefs } = input

    const interesting = filterInterestingTokens(tokens)
    const inScope = interesting.filter((t) =>
      enclosingDefs.some(
        (def) => t.line >= def.range.start.line && t.line <= def.range.end.line,
      ),
    )

    // Resolve all definitions in parallel
    const tokenTexts = inScope.map((t) => extractSymbolText(t, fileContent))
    const defResults = await Promise.all(
      inScope.map((token) =>
        conn.sendRequest("textDocument/definition", {
          textDocument: { uri: fileUri },
          position: { line: token.line, character: token.startChar },
        }),
      ),
    )

    const results: SymbolDefinition[] = []
    const seen = new Set<string>()

    for (let i = 0; i < inScope.length; i++) {
      const symbolText = tokenTexts[i]
      if (!symbolText) continue

      const locs = normalizeDefinitionResponse(defResults[i])
      for (const loc of locs) {
        const defPath = decodeURI(new URL(loc.uri).pathname)
        const key = `${symbolText}:${defPath}:${loc.line}`
        if (seen.has(key)) continue
        seen.add(key)

        results.push({
          symbol: symbolText,
          tokenType: inScope[i].tokenType,
          definedIn: {
            path: defPath,
            line: loc.line,
            character: loc.character,
            endLine: null,
            endCharacter: null,
          },
          usedAt: {
            path: filePath,
            line: inScope[i].line,
            character: inScope[i].startChar,
          },
          definitionText: null,
          docComment: null,
        })
      }
    }

    return results
  }

  // --- Enrichment: add definitionText, docComment, endLine/endCharacter ---

  // Enrich definitions with full text, doc comments, and end positions
  // by calling documentSymbol on each target file and reading source from disk.
  // This is a read-only operation — no didChange, no mutex needed for target files.
  export async function enrichDefinitions(
    conn: any,
    definitions: SymbolDefinition[],
    analyzedFilePath?: string,
  ): Promise<string[]> {
    const errors: string[] = []

    // Group by target file, skipping definitions that point back to the
    // file being analyzed (those reference virtual content not on disk)
    const byFile = new Map<string, SymbolDefinition[]>()
    for (const def of definitions) {
      if (analyzedFilePath && def.definedIn.path === analyzedFilePath) continue
      const existing = byFile.get(def.definedIn.path) ?? []
      existing.push(def)
      byFile.set(def.definedIn.path, existing)
    }

    for (const [filePath, defs] of byFile) {
      // Read file from disk
      let fileLines: string[]
      try {
        const content = require("fs").readFileSync(filePath, "utf-8")
        fileLines = content.split("\n")
      } catch (err: any) {
        errors.push(`enrichment: could not read ${filePath}: ${err.message ?? err}`)
        continue
      }

      // Get documentSymbol for this file (read-only, no didOpen needed)
      const fileUri = pathToFileURL(filePath).href
      const symbols = await conn.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: fileUri },
      })

      const normalizedSymbols =
        symbols && symbols.length > 0 ? normalizeSymbols(symbols) : []
      const allSymbols = flattenNormalized(normalizedSymbols)

      for (const def of defs) {
        // Find the enclosing symbol whose range contains the definition position
        const enclosing = allSymbols.find(
          (sym) =>
            def.definedIn.line >= sym.range.start.line &&
            def.definedIn.line <= sym.range.end.line,
        )

        if (enclosing) {
          const endChar = (enclosing.range.end as any).character
          if (endChar === undefined) {
            throw new Error(
              `Symbol '${enclosing.name}' in ${filePath} has range.end without character field`,
            )
          }
          def.definedIn.endLine = enclosing.range.end.line
          def.definedIn.endCharacter = endChar
          def.definitionText = extractDefinitionText(
            fileLines,
            enclosing.range.start.line,
            enclosing.range.end.line,
          )
          def.docComment = extractDocComment(fileLines, enclosing.range.start.line)
        } else {
          // No enclosing symbol found — extract docComment from the definition line
          def.docComment = extractDocComment(fileLines, def.definedIn.line)
        }
      }
    }

    return errors
  }

  function flattenNormalized(symbols: NormalizedSymbol[]): NormalizedSymbol[] {
    const result: NormalizedSymbol[] = []
    for (const s of symbols) {
      result.push(s)
      if (s.children) result.push(...flattenNormalized(s.children))
    }
    return result
  }

  // --- Per-document mutex ---

  const documentLocks = new Map<string, Promise<void>>()

  export async function withDocumentLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const key = filePath
    const previous = documentLocks.get(key) ?? Promise.resolve()
    let release: () => void
    const lock = new Promise<void>((r) => {
      release = r
    })
    documentLocks.set(key, lock)
    await previous
    try {
      return await fn()
    } finally {
      release!()
      if (documentLocks.get(key) === lock) {
        documentLocks.delete(key)
      }
    }
  }

  // --- Progress tracking ---

  /**
   * Wait for an LSP server to become idle by monitoring $/progress notifications.
   * Falls back to a timeout if no progress events are received.
   */
  export async function waitForServerReady(conn: any, maxMs: number = 10000): Promise<void> {
    const activeProgress = new Set<string>()
    let unsub: (() => void) | undefined

    try {
      unsub = conn.onNotification("$/progress", (params: any) => {
        if (params.value?.kind === "begin") activeProgress.add(String(params.token))
        if (params.value?.kind === "end") activeProgress.delete(String(params.token))
      })?.dispose

      const start = Date.now()

      // Wait for at least one progress to start (server may not have started indexing yet)
      while (activeProgress.size === 0 && Date.now() - start < Math.min(maxMs, 3000)) {
        await new Promise((r) => setTimeout(r, 100))
      }

      // Wait for all active progress to complete
      while (activeProgress.size > 0 && Date.now() - start < maxMs) {
        await new Promise((r) => setTimeout(r, 200))
      }
    } finally {
      unsub?.()
    }
  }

  // --- Full pipeline ---

  /**
   * A function that pushes content to the LSP server for a given file.
   * This abstraction allows the caller to provide either:
   * - A raw connection (for tests): sends didOpen/didChange directly
   * - An LSPClient.notify.change method (for production): coordinates with client state
   */
  export type ContentPusher = (filePath: string, content: string) => Promise<void>

  /**
   * Create a ContentPusher from a raw vscode-jsonrpc connection.
   * Tracks open state per-connection to avoid duplicate didOpen.
   */
  export function rawConnectionPusher(conn: any): ContentPusher {
    const opened = new Set<string>()
    let version = 1000

    return async (filePath: string, content: string) => {
      const uri = pathToFileURL(filePath).href
      const ext = require("path").extname(filePath)
      const languageId = LANGUAGE_EXTENSIONS[ext] ?? "plaintext"

      if (opened.has(uri)) {
        await conn.sendNotification("textDocument/didChange", {
          textDocument: { uri, version: ++version },
          contentChanges: [{ text: content }],
        })
      } else {
        await conn.sendNotification("textDocument/didOpen", {
          textDocument: { uri, languageId, version: ++version, text: content },
        })
        opened.add(uri)
      }
    }
  }

  /**
   * Analyze one side (before or after) of a file.
   */
  async function analyzeOneSide(input: {
    conn: any
    pushContent: ContentPusher
    fileUri: string
    filePath: string
    content: string
    hunkRanges: Array<{ start: number; end: number }>
    legend: Legend
  }): Promise<SymbolDefinition[]> {
    const { conn, pushContent, fileUri, filePath, content, hunkRanges, legend } = input

    // Push content to LSP
    await pushContent(filePath, content)

    // Retry loop: semantic tokens may appear before definitions resolve
    // (e.g., server still indexing cross-file dependencies).
    const delays = [50, 200, 500, 1500, 3000]

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, delays[attempt - 1]))
      }

      const [symbols, tokensResult] = await Promise.all([
        conn.sendRequest("textDocument/documentSymbol", { textDocument: { uri: fileUri } }),
        conn.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri: fileUri } }),
      ])

      if (!tokensResult?.data || tokensResult.data.length === 0) continue

      const enclosingDefs = findEnclosingDefinitions(symbols, hunkRanges)
      if (enclosingDefs.length === 0) {
        return []
      }

      const tokens = decodeSemanticTokens(tokensResult.data, legend)
      const defs = await resolveTokenDefinitions({
        conn,
        fileUri,
        filePath,
        fileContent: content,
        tokens,
        enclosingDefs,
        legend,
      })

      if (defs.length > 0 || attempt >= 2) return defs
    }

    throw new Error(
      `Failed to get semantic tokens for ${filePath} after ${delays.length + 1} attempts`,
    )
  }

  /**
   * Core entry point: analyze a single file's before and after content.
   * Caller provides both contents explicitly — no diff parsing or file I/O.
   */
  export async function analyzeFile(input: {
    conn: any
    legend: Legend
    filePath: string
    fileUri: string
    originalContent: string
    patchedContent: string
    beforeHunkRanges: Array<{ start: number; end: number }>
    afterHunkRanges: Array<{ start: number; end: number }>
    pushContent?: ContentPusher
  }): Promise<{ definitions: SymbolDefinition[]; errors: string[] }> {
    const {
      conn,
      legend,
      filePath,
      fileUri,
      originalContent,
      patchedContent,
      beforeHunkRanges,
      afterHunkRanges,
    } = input
    const pushContent = input.pushContent ?? rawConnectionPusher(conn)
    const allDefs: SymbolDefinition[] = []
    let enrichErrors: string[] = []

    await withDocumentLock(filePath, async () => {
      // Push initial content
      await pushContent(filePath, originalContent)

      // Before-side analysis
      if (originalContent && beforeHunkRanges.some((h) => h.end > h.start)) {
        const defs = await analyzeOneSide({
          conn,
          pushContent,
          fileUri,
          filePath,
          content: originalContent,
          hunkRanges: beforeHunkRanges,
          legend,
        })
        allDefs.push(...defs)
      }

      // After-side analysis
      if (patchedContent && afterHunkRanges.some((h) => h.end > h.start)) {
        const defs = await analyzeOneSide({
          conn,
          pushContent,
          fileUri,
          filePath,
          content: patchedContent,
          hunkRanges: afterHunkRanges,
          legend,
        })
        allDefs.push(...defs)
      }

      // Enrich definitions with full text, doc comments, and end positions.
      // Runs inside the mutex so that documentSymbol on the analyzed file
      // sees consistent content.
      enrichErrors = await enrichDefinitions(conn, allDefs, filePath)
    })

    // Deduplicate
    const seen = new Set<string>()
    const definitions = allDefs.filter((def) => {
      const key = `${def.symbol}:${def.definedIn.path}:${def.definedIn.line}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    return { definitions, errors: enrichErrors }
  }
}
