import { describe, expect, test } from "bun:test"
import { ContextDefs } from "../../src/lsp/context-defs"

describe("decodeSemanticTokens", () => {
  const legend = {
    tokenTypes: ["function", "variable", "struct", "comment", "keyword"],
    tokenModifiers: ["declaration", "definition", "readonly", "static"],
  }

  test("1. empty data array returns empty tokens", () => {
    const result = ContextDefs.decodeSemanticTokens([], legend)
    expect(result).toEqual([])
  })

  test("2. single token decodes correctly", () => {
    const result = ContextDefs.decodeSemanticTokens([0, 5, 3, 0, 0], legend)
    expect(result).toEqual([
      { line: 0, startChar: 5, length: 3, tokenType: "function", modifiers: [] },
    ])
  })

  test("3. two tokens same line: char is relative to previous", () => {
    // First token at char 5, second at char 5+10=15
    const result = ContextDefs.decodeSemanticTokens([0, 5, 3, 0, 0, 0, 10, 4, 1, 0], legend)
    expect(result[0].startChar).toBe(5)
    expect(result[1].startChar).toBe(15)
    expect(result[1].tokenType).toBe("variable")
  })

  test("4. two tokens different lines: deltaLine>0 resets char", () => {
    // First token at line 0, char 5; second at line 2, char 3
    const result = ContextDefs.decodeSemanticTokens([0, 5, 3, 0, 0, 2, 3, 4, 1, 0], legend)
    expect(result[0]).toMatchObject({ line: 0, startChar: 5 })
    expect(result[1]).toMatchObject({ line: 2, startChar: 3 })
  })

  test("5. token modifier bitset decoded: bits 0+1", () => {
    const result = ContextDefs.decodeSemanticTokens([0, 0, 5, 0, 3], legend)
    expect(result[0].modifiers).toEqual(["declaration", "definition"])
  })

  test("6. single modifier bit: bit 1 only", () => {
    const result = ContextDefs.decodeSemanticTokens([0, 0, 5, 0, 2], legend)
    expect(result[0].modifiers).toEqual(["definition"])
  })

  test("7. zero modifier bitset → empty modifiers", () => {
    const result = ContextDefs.decodeSemanticTokens([0, 0, 5, 0, 0], legend)
    expect(result[0].modifiers).toEqual([])
  })

  test("8. out-of-range tokenType index throws", () => {
    expect(() => ContextDefs.decodeSemanticTokens([0, 0, 5, 99, 0], legend)).toThrow(
      "Semantic token type index 99 out of range",
    )
  })

  test("9. large array (50+ tokens) accumulates correctly", () => {
    // Generate 60 tokens, each on a new line at char 0, length 3, type 0
    const data: number[] = []
    for (let i = 0; i < 60; i++) {
      data.push(i === 0 ? 0 : 1, 0, 3, 0, 0)
    }
    const result = ContextDefs.decodeSemanticTokens(data, legend)
    expect(result.length).toBe(60)
    expect(result[59].line).toBe(59)
    expect(result[59].startChar).toBe(0)
  })

  test("10. data length not multiple of 5 throws", () => {
    expect(() => ContextDefs.decodeSemanticTokens([0, 5, 3], legend)).toThrow()
  })

  test("11. multiple lines accumulate correctly", () => {
    // 5 tokens: line 0 char 2, line 0 char 8, line 1 char 4, line 3 char 0, line 3 char 10
    const data = [
      0, 2, 3, 0, 0, // line 0, char 2
      0, 6, 3, 1, 0, // line 0, char 2+6=8
      1, 4, 3, 2, 0, // line 1, char 4
      2, 0, 3, 0, 0, // line 3, char 0
      0, 10, 3, 1, 0, // line 3, char 0+10=10
    ]
    const result = ContextDefs.decodeSemanticTokens(data, legend)
    expect(result.map((t) => [t.line, t.startChar])).toEqual([
      [0, 2],
      [0, 8],
      [1, 4],
      [3, 0],
      [3, 10],
    ])
  })

  test("12. deltaLine=0 for consecutive same-line tokens", () => {
    // Three tokens on line 0: char 0, char 5, char 12
    const data = [
      0, 0, 3, 0, 0, // char 0
      0, 5, 3, 1, 0, // char 0+5=5
      0, 7, 3, 2, 0, // char 5+7=12
    ]
    const result = ContextDefs.decodeSemanticTokens(data, legend)
    expect(result.map((t) => t.startChar)).toEqual([0, 5, 12])
  })

  test("13. test with real rust-analyzer legend (many types)", () => {
    const raLegend = {
      tokenTypes: [
        "comment",
        "decorator",
        "enumMember",
        "enum",
        "function",
        "interface",
        "keyword",
        "macro",
        "method",
        "namespace",
        "number",
        "operator",
        "parameter",
        "property",
        "string",
        "struct",
        "typeParameter",
        "variable",
        "angle",
        "arithmetic",
        "attribute",
        "attributeBracket",
        "bitwise",
        "boolean",
        "brace",
        "bracket",
        "builtinAttribute",
        "builtinType",
        "character",
        "colon",
        "comma",
        "comparison",
        "constParameter",
        "derive",
        "deriveHelper",
        "dot",
        "escapeSequence",
        "invalidEscapeSequence",
        "formatSpecifier",
        "generic",
        "label",
        "lifetime",
        "logical",
        "macroBang",
        "procMacro",
        "parenthesis",
        "punctuation",
        "selfKeyword",
        "selfTypeKeyword",
        "semicolon",
        "typeAlias",
        "toolModule",
        "union",
        "unresolvedReference",
      ],
      tokenModifiers: [
        "async",
        "documentation",
        "declaration",
        "static",
        "defaultLibrary",
        "associated",
        "attribute",
        "callable",
        "constant",
        "consuming",
        "controlFlow",
        "crateRoot",
        "injected",
        "intraDocLink",
        "library",
        "macro",
        "proc_macro",
        "mutable",
        "public",
        "reference",
        "trait",
        "unsafe",
      ],
    }
    // Token: line 0, char 4, length 4, type index 15 (struct), modifiers: bit 2 (declaration) + bit 18 (public)
    const modBits = (1 << 2) | (1 << 18) // declaration + public
    const data = [0, 4, 4, 15, modBits]
    const result = ContextDefs.decodeSemanticTokens(data, raLegend)
    expect(result[0].tokenType).toBe("struct")
    expect(result[0].modifiers).toContain("declaration")
    expect(result[0].modifiers).toContain("public")
    expect(result[0].modifiers.length).toBe(2)
  })
})

describe("filterInterestingTokens", () => {
  const make = (tokenType: string): ContextDefs.SemanticToken => ({
    line: 0,
    startChar: 0,
    length: 3,
    tokenType,
    modifiers: [],
  })

  test("14. keeps function", () => {
    expect(ContextDefs.filterInterestingTokens([make("function")])).toHaveLength(1)
  })
  test("15. keeps method", () => {
    expect(ContextDefs.filterInterestingTokens([make("method")])).toHaveLength(1)
  })
  test("16. keeps struct", () => {
    expect(ContextDefs.filterInterestingTokens([make("struct")])).toHaveLength(1)
  })
  test("17. keeps property", () => {
    expect(ContextDefs.filterInterestingTokens([make("property")])).toHaveLength(1)
  })
  test("18. keeps variable", () => {
    expect(ContextDefs.filterInterestingTokens([make("variable")])).toHaveLength(1)
  })
  test("19. keeps parameter", () => {
    expect(ContextDefs.filterInterestingTokens([make("parameter")])).toHaveLength(1)
  })
  test("20. keeps namespace", () => {
    expect(ContextDefs.filterInterestingTokens([make("namespace")])).toHaveLength(1)
  })
  test("21. keeps macro", () => {
    expect(ContextDefs.filterInterestingTokens([make("macro")])).toHaveLength(1)
  })
  test("22. keeps enum", () => {
    expect(ContextDefs.filterInterestingTokens([make("enum")])).toHaveLength(1)
  })
  test("23. keeps enumMember", () => {
    expect(ContextDefs.filterInterestingTokens([make("enumMember")])).toHaveLength(1)
  })
  test("24. filters out keyword", () => {
    expect(ContextDefs.filterInterestingTokens([make("keyword")])).toHaveLength(0)
  })
  test("25. filters out operator", () => {
    expect(ContextDefs.filterInterestingTokens([make("operator")])).toHaveLength(0)
  })
  test("26. filters out comment", () => {
    expect(ContextDefs.filterInterestingTokens([make("comment")])).toHaveLength(0)
  })
  test("27. filters out string", () => {
    expect(ContextDefs.filterInterestingTokens([make("string")])).toHaveLength(0)
  })
  test("28. filters out number", () => {
    expect(ContextDefs.filterInterestingTokens([make("number")])).toHaveLength(0)
  })
  test("29. filters out selfKeyword", () => {
    expect(ContextDefs.filterInterestingTokens([make("selfKeyword")])).toHaveLength(0)
  })
  test("30. filters out lifetime", () => {
    expect(ContextDefs.filterInterestingTokens([make("lifetime")])).toHaveLength(0)
  })
  test("31. filters out builtinType", () => {
    expect(ContextDefs.filterInterestingTokens([make("builtinType")])).toHaveLength(0)
  })
})

describe("extractSymbolText", () => {
  const content = "fn foo() {\n    bar(baz);\n\n    let x = 42;\n}"

  test("32. extracts symbol from single-line content", () => {
    // "bar" is at line 1, char 4, length 3
    const token: ContextDefs.SemanticToken = { line: 1, startChar: 4, length: 3, tokenType: "function", modifiers: [] }
    expect(ContextDefs.extractSymbolText(token, content)).toBe("bar")
  })

  test("33. extracts from content with varying line lengths", () => {
    // "baz" is at line 1, char 8, length 3
    const token: ContextDefs.SemanticToken = { line: 1, startChar: 8, length: 3, tokenType: "variable", modifiers: [] }
    expect(ContextDefs.extractSymbolText(token, content)).toBe("baz")
  })

  test("34. extracts symbol at column 0", () => {
    // "fn" is at line 0, char 0, length 2
    const token: ContextDefs.SemanticToken = { line: 0, startChar: 0, length: 2, tokenType: "keyword", modifiers: [] }
    expect(ContextDefs.extractSymbolText(token, content)).toBe("fn")
  })

  test("35. extracts symbol at end of line", () => {
    // "42" is at line 3, char 12, length 2 — "    let x = 42;"
    const token: ContextDefs.SemanticToken = { line: 3, startChar: 12, length: 2, tokenType: "number", modifiers: [] }
    expect(ContextDefs.extractSymbolText(token, content)).toBe("42")
  })

  test("36. handles empty line gracefully", () => {
    // Line 2 is empty
    const token: ContextDefs.SemanticToken = { line: 2, startChar: 0, length: 0, tokenType: "unknown", modifiers: [] }
    expect(ContextDefs.extractSymbolText(token, content)).toBe("")
  })

  test("37. handles token extending beyond line length", () => {
    // Line 4 is "}" (length 1), but token says length 10
    const token: ContextDefs.SemanticToken = { line: 4, startChar: 0, length: 10, tokenType: "unknown", modifiers: [] }
    const result = ContextDefs.extractSymbolText(token, content)
    expect(result).toBe("}")
  })
})

describe("parseUnifiedDiff", () => {
  test("38. single-file diff extracts correct path", () => {
    const diff = `diff --git a/src/game.rs b/src/game.rs
index abc1234..def5678 100644
--- a/src/game.rs
+++ b/src/game.rs
@@ -10,3 +10,4 @@ impl Game {
     fn foo() {}
     fn bar() {}
+    fn baz() {}
 }
`
    const result = ContextDefs.parseUnifiedDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe("src/game.rs")
  })

  test("39. multi-file diff extracts all paths", () => {
    const diff = `diff --git a/src/a.rs b/src/a.rs
--- a/src/a.rs
+++ b/src/a.rs
@@ -1,1 +1,2 @@
 line1
+line2
diff --git a/src/b.rs b/src/b.rs
--- a/src/b.rs
+++ b/src/b.rs
@@ -1,1 +1,2 @@
 line1
+line2
diff --git a/src/c.rs b/src/c.rs
--- a/src/c.rs
+++ b/src/c.rs
@@ -1,1 +1,2 @@
 line1
+line2
`
    const result = ContextDefs.parseUnifiedDiff(diff)
    expect(result.map((r) => r.path)).toEqual(["src/a.rs", "src/b.rs", "src/c.rs"])
  })

  test("40. affected lines computed from hunk header", () => {
    const diff = `--- a/src/game.rs
+++ b/src/game.rs
@@ -10,5 +10,7 @@ impl Game {
     fn foo() {}
     fn bar() {}
+    fn baz() {}
+    fn qux() {}
     fn end() {}
 }
`
    const result = ContextDefs.parseUnifiedDiff(diff)
    // Hunk starts at line 10 (1-based) in the new file, so 0-based start is 9
    // Hunk spans 7 lines in new file, so end is 9+7=16 (exclusive)
    expect(result[0].hunks).toHaveLength(1)
    expect(result[0].hunks[0].newStart).toBe(9) // 0-based
    expect(result[0].hunks[0].newLines).toBe(7)
  })

  test("41. addition-only hunk: correct affected range", () => {
    const diff = `--- a/src/game.rs
+++ b/src/game.rs
@@ -5,0 +6,3 @@ impl Game {
+    fn new1() {}
+    fn new2() {}
+    fn new3() {}
`
    const result = ContextDefs.parseUnifiedDiff(diff)
    expect(result[0].hunks[0].newStart).toBe(5) // line 6 is 0-based 5
    expect(result[0].hunks[0].newLines).toBe(3)
  })

  test("42. deletion-only hunk", () => {
    const diff = `--- a/src/game.rs
+++ b/src/game.rs
@@ -5,3 +5,0 @@ impl Game {
-    fn old1() {}
-    fn old2() {}
-    fn old3() {}
`
    const result = ContextDefs.parseUnifiedDiff(diff)
    expect(result[0].hunks[0].newLines).toBe(0)
    expect(result[0].hunks[0].oldStart).toBe(4) // line 5 is 0-based 4
    expect(result[0].hunks[0].oldLines).toBe(3)
  })

  test("43. multiple hunks in same file", () => {
    const diff = `--- a/src/game.rs
+++ b/src/game.rs
@@ -5,3 +5,4 @@
 line5
 line6
+newline
 line7
@@ -20,3 +21,4 @@
 line20
 line21
+another
 line22
`
    const result = ContextDefs.parseUnifiedDiff(diff)
    expect(result[0].hunks).toHaveLength(2)
  })

  test("44. applyPatch produces correct patched content", () => {
    const original = "line1\nline2\nline3\n"
    const diff = `--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line1
+inserted
 line2
 line3
`
    const result = ContextDefs.applyDiff(original, diff)
    expect(result).toBe("line1\ninserted\nline2\nline3\n")
  })

  test("45. applyPatch returns false on context mismatch", () => {
    const original = "totally different content\n"
    const diff = `--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line1
+inserted
 line2
 line3
`
    expect(() => ContextDefs.applyDiff(original, diff)).toThrow()
  })

  test("46. handles diff without a/ b/ prefixes", () => {
    const diff = `--- src/game.rs
+++ src/game.rs
@@ -1,1 +1,2 @@
 line1
+line2
`
    const result = ContextDefs.parseUnifiedDiff(diff)
    expect(result[0].path).toBe("src/game.rs")
  })

  test("47. new file diff (--- /dev/null)", () => {
    const diff = `diff --git a/src/new.rs b/src/new.rs
new file mode 100644
--- /dev/null
+++ b/src/new.rs
@@ -0,0 +1,3 @@
+fn hello() {}
+fn world() {}
+fn end() {}
`
    const result = ContextDefs.parseUnifiedDiff(diff)
    expect(result[0].path).toBe("src/new.rs")
    expect(result[0].isNew).toBe(true)
    expect(result[0].hunks[0].newStart).toBe(0)
    expect(result[0].hunks[0].newLines).toBe(3)
  })

  test("48. deleted file diff (+++ /dev/null)", () => {
    const diff = `diff --git a/src/old.rs b/src/old.rs
deleted file mode 100644
--- a/src/old.rs
+++ /dev/null
@@ -1,3 +0,0 @@
-fn hello() {}
-fn world() {}
-fn end() {}
`
    const result = ContextDefs.parseUnifiedDiff(diff)
    expect(result[0].path).toBe("src/old.rs")
    expect(result[0].isDeleted).toBe(true)
  })

  test("49. diff with no newline at end of file marker", () => {
    const diff = `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 line1
-line2
\\ No newline at end of file
+line2modified
\\ No newline at end of file
`
    const result = ContextDefs.parseUnifiedDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].hunks).toHaveLength(1)
  })

  test("50. diff with only mode change", () => {
    const diff = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
`
    const result = ContextDefs.parseUnifiedDiff(diff)
    // No content hunks
    expect(result).toHaveLength(0)
  })

  test("51. diff with rename header", () => {
    const diff = `diff --git a/old.rs b/new.rs
similarity index 95%
rename from old.rs
rename to new.rs
--- a/old.rs
+++ b/new.rs
@@ -1,2 +1,3 @@
 line1
 line2
+line3
`
    const result = ContextDefs.parseUnifiedDiff(diff)
    expect(result[0].path).toBe("new.rs")
  })

  test("52. diff with CRLF line endings", () => {
    const diff = "--- a/file.txt\r\n+++ b/file.txt\r\n@@ -1,1 +1,2 @@\r\n line1\r\n+line2\r\n"
    const result = ContextDefs.parseUnifiedDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe("file.txt")
  })

  test("53. diff with empty hunk (0 lines changed)", () => {
    // This is unusual but can happen
    const diff = `diff --git a/file.rs b/file.rs
old mode 100644
new mode 100755
--- a/file.rs
+++ b/file.rs
`
    const result = ContextDefs.parseUnifiedDiff(diff)
    // No hunks means no content changes
    expect(result.length === 0 || result[0].hunks.length === 0).toBe(true)
  })
})

describe("normalizeDefinitionResponse", () => {
  test("54. null returns empty array", () => {
    expect(ContextDefs.normalizeDefinitionResponse(null)).toEqual([])
  })

  test("55. undefined returns empty array", () => {
    expect(ContextDefs.normalizeDefinitionResponse(undefined)).toEqual([])
  })

  test("56. single Location object", () => {
    const loc = { uri: "file:///foo.rs", range: { start: { line: 5, character: 10 }, end: { line: 5, character: 15 } } }
    const result = ContextDefs.normalizeDefinitionResponse(loc)
    expect(result).toEqual([{ uri: "file:///foo.rs", line: 5, character: 10, endLine: 5, endCharacter: 15 }])
  })

  test("57. array of Location objects", () => {
    const locs = [
      { uri: "file:///a.rs", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
      { uri: "file:///b.rs", range: { start: { line: 10, character: 3 }, end: { line: 10, character: 8 } } },
    ]
    const result = ContextDefs.normalizeDefinitionResponse(locs)
    expect(result).toHaveLength(2)
    expect(result[0].uri).toBe("file:///a.rs")
    expect(result[1].uri).toBe("file:///b.rs")
  })

  test("58. LocationLink format (targetUri/targetRange)", () => {
    const link = {
      targetUri: "file:///target.rs",
      targetRange: { start: { line: 20, character: 0 }, end: { line: 25, character: 1 } },
      targetSelectionRange: { start: { line: 20, character: 4 }, end: { line: 20, character: 10 } },
    }
    const result = ContextDefs.normalizeDefinitionResponse(link)
    expect(result).toEqual([{ uri: "file:///target.rs", line: 20, character: 0, endLine: 25, endCharacter: 1 }])
  })

  test("59. array with null entries filtered out", () => {
    const locs = [
      null,
      { uri: "file:///a.rs", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
      null,
    ]
    const result = ContextDefs.normalizeDefinitionResponse(locs)
    expect(result).toHaveLength(1)
  })

  test("60. empty array returns empty", () => {
    expect(ContextDefs.normalizeDefinitionResponse([])).toEqual([])
  })
})

describe("findEnclosingDefinitions", () => {
  // Test with flat SymbolInformation format
  const flatSymbols = [
    { name: "MY_CONST", kind: 14, location: { range: { start: { line: 0 }, end: { line: 0 } } } },
    { name: "MyStruct", kind: 23, location: { range: { start: { line: 2 }, end: { line: 6 } } } },
    { name: "field1", kind: 8, location: { range: { start: { line: 3 }, end: { line: 3 } } }, containerName: "MyStruct" },
    { name: "my_fn", kind: 12, location: { range: { start: { line: 8 }, end: { line: 15 } } } },
    { name: "other_fn", kind: 12, location: { range: { start: { line: 17 }, end: { line: 25 } } } },
  ]

  test("61. hunk inside struct finds struct", () => {
    const result = ContextDefs.findEnclosingDefinitions(flatSymbols, [{ start: 3, end: 4 }])
    expect(result.map((s) => s.name)).toContain("MyStruct")
  })

  test("62. hunk inside function finds function", () => {
    const result = ContextDefs.findEnclosingDefinitions(flatSymbols, [{ start: 10, end: 12 }])
    expect(result.map((s) => s.name)).toContain("my_fn")
    expect(result.map((s) => s.name)).not.toContain("other_fn")
  })

  test("63. hunk at module level (const) finds nothing interesting", () => {
    const result = ContextDefs.findEnclosingDefinitions(flatSymbols, [{ start: 0, end: 0 }])
    // MY_CONST is kind 14 (Constant), not in our interesting set
    expect(result.map((s) => s.name)).not.toContain("MY_CONST")
  })

  test("64. hunk spanning two functions finds both", () => {
    const result = ContextDefs.findEnclosingDefinitions(flatSymbols, [{ start: 14, end: 18 }])
    expect(result.map((s) => s.name)).toContain("my_fn")
    expect(result.map((s) => s.name)).toContain("other_fn")
  })

  test("65. empty symbols returns empty", () => {
    const result = ContextDefs.findEnclosingDefinitions([], [{ start: 0, end: 10 }])
    expect(result).toEqual([])
  })

  test("66. empty hunk ranges returns empty", () => {
    const result = ContextDefs.findEnclosingDefinitions(flatSymbols, [])
    expect(result).toEqual([])
  })

  // Test with nested DocumentSymbol format
  const nestedSymbols = [
    {
      name: "MyStruct",
      kind: 23,
      range: { start: { line: 0 }, end: { line: 5 } },
      children: [
        { name: "field1", kind: 8, range: { start: { line: 1 }, end: { line: 1 } } },
      ],
    },
    {
      name: "impl MyStruct",
      kind: 2, // Module (impl blocks often show as this)
      range: { start: { line: 7 }, end: { line: 20 } },
      children: [
        { name: "method_a", kind: 6, range: { start: { line: 8 }, end: { line: 12 } } },
        { name: "method_b", kind: 6, range: { start: { line: 14 }, end: { line: 19 } } },
      ],
    },
  ]

  test("67. nested: hunk in method_a finds method_a not impl block", () => {
    const result = ContextDefs.findEnclosingDefinitions(nestedSymbols, [{ start: 9, end: 11 }])
    expect(result.map((s) => s.name)).toContain("method_a")
    expect(result.map((s) => s.name)).not.toContain("impl MyStruct")
  })

  test("68. nested: hunk spanning method_a and method_b finds both", () => {
    const result = ContextDefs.findEnclosingDefinitions(nestedSymbols, [{ start: 11, end: 15 }])
    expect(result.map((s) => s.name)).toContain("method_a")
    expect(result.map((s) => s.name)).toContain("method_b")
  })

  test("69. nested: hunk in struct body finds struct", () => {
    const result = ContextDefs.findEnclosingDefinitions(nestedSymbols, [{ start: 1, end: 2 }])
    expect(result.map((s) => s.name)).toContain("MyStruct")
  })

  test("70. multiple separate hunks each find their enclosing def", () => {
    const result = ContextDefs.findEnclosingDefinitions(flatSymbols, [
      { start: 3, end: 4 },   // inside MyStruct
      { start: 20, end: 22 }, // inside other_fn
    ])
    const names = result.map((s) => s.name)
    expect(names).toContain("MyStruct")
    expect(names).toContain("other_fn")
    expect(names).not.toContain("my_fn")
  })

  test("71. hunk exactly matching symbol range includes it", () => {
    const result = ContextDefs.findEnclosingDefinitions(flatSymbols, [{ start: 8, end: 15 }])
    expect(result.map((s) => s.name)).toContain("my_fn")
  })

  test("72. hunk with single line overlapping symbol boundary", () => {
    // Hunk at line 15 — the last line of my_fn (8-15)
    const result = ContextDefs.findEnclosingDefinitions(flatSymbols, [{ start: 15, end: 15 }])
    expect(result.map((s) => s.name)).toContain("my_fn")
  })
})

describe("rawConnectionPusher", () => {
  test("73. first call sends didOpen, second sends didChange", async () => {
    const sent: Array<{ method: string; params: any }> = []
    const fakeConn = {
      sendNotification: async (method: string, params: any) => {
        sent.push({ method, params })
      },
    }

    const pusher = ContextDefs.rawConnectionPusher(fakeConn)
    await pusher("/tmp/test.rs", "content1")
    await pusher("/tmp/test.rs", "content2")

    expect(sent[0].method).toBe("textDocument/didOpen")
    expect(sent[0].params.textDocument.text).toBe("content1")
    expect(sent[1].method).toBe("textDocument/didChange")
    expect(sent[1].params.contentChanges[0].text).toBe("content2")
  })

  test("74. different files get separate didOpen calls", async () => {
    const sent: Array<{ method: string; params: any }> = []
    const fakeConn = {
      sendNotification: async (method: string, params: any) => {
        sent.push({ method, params })
      },
    }

    const pusher = ContextDefs.rawConnectionPusher(fakeConn)
    await pusher("/tmp/a.rs", "contentA")
    await pusher("/tmp/b.rs", "contentB")

    expect(sent[0].method).toBe("textDocument/didOpen")
    expect(sent[1].method).toBe("textDocument/didOpen")
  })

  test("75. version numbers increment", async () => {
    const sent: Array<{ method: string; params: any }> = []
    const fakeConn = {
      sendNotification: async (method: string, params: any) => {
        sent.push({ method, params })
      },
    }

    const pusher = ContextDefs.rawConnectionPusher(fakeConn)
    await pusher("/tmp/test.rs", "v1")
    await pusher("/tmp/test.rs", "v2")
    await pusher("/tmp/test.rs", "v3")

    const versions = sent.map(
      (s) => s.params.textDocument?.version ?? s.params.textDocument?.version,
    )
    // Each version should be greater than the last
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1])
    }
  })

  test("76. uses LANGUAGE_EXTENSIONS for languageId", async () => {
    const sent: Array<{ method: string; params: any }> = []
    const fakeConn = {
      sendNotification: async (method: string, params: any) => {
        sent.push({ method, params })
      },
    }

    const pusher = ContextDefs.rawConnectionPusher(fakeConn)
    await pusher("/tmp/test.rs", "fn main() {}")
    await pusher("/tmp/test.ts", "const x = 1")
    await pusher("/tmp/test.py", "def foo(): pass")

    expect(sent[0].params.textDocument.languageId).toBe("rust")
    expect(sent[1].params.textDocument.languageId).toBe("typescript")
    expect(sent[2].params.textDocument.languageId).toBe("python")
  })
})

describe("extractSingleFileDiff (via parseUnifiedDiff + applyDiff)", () => {
  test("77. createTwoFilesPatch format (=== header) parses correctly", () => {
    const diff = `===================================================================
--- a/src/tile.rs
+++ b/src/tile.rs
@@ -1,3 +1,4 @@
 line1
 line2
+line3
 line4
`
    const result = ContextDefs.parseUnifiedDiff(diff)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe("src/tile.rs")
    expect(result[0].hunks).toHaveLength(1)
  })

  test("78. createTwoFilesPatch applies correctly", () => {
    const original = "line1\nline2\nline4\n"
    const diff = `===================================================================
--- a/file.rs
+++ b/file.rs
@@ -1,3 +1,4 @@
 line1
 line2
+line3
 line4
`
    const result = ContextDefs.applyDiff(original, diff)
    expect(result).toBe("line1\nline2\nline3\nline4\n")
  })
})

describe("extractDocComment", () => {
  test("79. collects /// doc comment lines", () => {
    const lines = [
      "/// This is a doc comment",
      "/// with two lines",
      "fn foo() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 2)).toBe("/// This is a doc comment\n/// with two lines")
  })

  test("80. collects // regular comment lines", () => {
    const lines = [
      "// This is a regular comment",
      "// also collected",
      "fn foo() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 2)).toBe("// This is a regular comment\n// also collected")
  })

  test("81. collects /** */ block doc comments", () => {
    const lines = [
      "/** This is a block doc comment */",
      "fn foo() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 1)).toBe("/** This is a block doc comment */")
  })

  test("82. collects multi-line /** */ block doc comments", () => {
    const lines = [
      "/**",
      " * Multi-line block doc",
      " * comment here",
      " */",
      "fn foo() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 4)).toBe("/**\n * Multi-line block doc\n * comment here\n */")
  })

  test("83. does NOT collect /* */ non-doc block comments", () => {
    const lines = [
      "/* This is a non-doc block comment */",
      "fn foo() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 1)).toBe(null)
  })

  test("84. does NOT collect multi-line /* */ non-doc comments", () => {
    const lines = [
      "/*",
      " * non-doc block",
      " */",
      "fn foo() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 3)).toBe(null)
  })

  test("85. blank lines within comment block are included", () => {
    const lines = [
      "/// First line",
      "",
      "/// Third line",
      "fn foo() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 3)).toBe("/// First line\n\n/// Third line")
  })

  test("86. returns null when no comments above", () => {
    const lines = [
      "fn bar() {}",
      "fn foo() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 1)).toBe(null)
  })

  test("87. stops at non-comment code line", () => {
    const lines = [
      "/// Comment for bar",
      "fn bar() {}",
      "/// Comment for foo",
      "fn foo() {}",
    ]
    // Only collects the comment directly above foo, not the one above bar
    expect(ContextDefs.extractDocComment(lines, 3)).toBe("/// Comment for foo")
  })

  test("88. returns null for definition at line 0", () => {
    const lines = ["fn foo() {}"]
    expect(ContextDefs.extractDocComment(lines, 0)).toBe(null)
  })

  test("89. mixed /// and // comments collected together", () => {
    const lines = [
      "// Regular comment",
      "/// Doc comment",
      "fn foo() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 2)).toBe("// Regular comment\n/// Doc comment")
  })

  test("90. handles indented comments", () => {
    const lines = [
      "    /// Indented doc comment",
      "    /// Second line",
      "    fn foo() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 2)).toBe("    /// Indented doc comment\n    /// Second line")
  })

  test("91. /** */ immediately above definition", () => {
    const lines = [
      "some code;",
      "/** Brief doc */",
      "fn foo() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 2)).toBe("/** Brief doc */")
  })

  test("92. /* */ immediately above stops collection (not collected)", () => {
    const lines = [
      "/// Doc comment above the block",
      "/* non-doc */",
      "fn foo() {}",
    ]
    // The /* */ blocks the collection — only what's directly above counts
    // The /* */ is not collected, and since it's code-like, it stops the walk
    expect(ContextDefs.extractDocComment(lines, 2)).toBe(null)
  })

  test("93. attribute between comment and definition: stops collection", () => {
    const lines = [
      "/// Doc comment",
      "#[derive(Clone)]",
      "struct Foo {}",
    ]
    // The attribute is not a comment, so it stops the backward walk
    expect(ContextDefs.extractDocComment(lines, 2)).toBe(null)
  })
})

describe("extractDefinitionText", () => {
  const lines = [
    "fn foo() {",        // 0
    "    let x = 1;",    // 1
    "    let y = 2;",    // 2
    "}",                 // 3
    "",                  // 4
    "struct Bar {",      // 5
    "    field: i32,",   // 6
    "}",                 // 7
  ]

  test("94. extracts function body from start to end line", () => {
    expect(ContextDefs.extractDefinitionText(lines, 0, 3)).toBe(
      "fn foo() {\n    let x = 1;\n    let y = 2;\n}",
    )
  })

  test("95. extracts struct body", () => {
    expect(ContextDefs.extractDefinitionText(lines, 5, 7)).toBe(
      "struct Bar {\n    field: i32,\n}",
    )
  })

  test("96. single-line definition", () => {
    const singleLine = ["fn noop() {}"]
    expect(ContextDefs.extractDefinitionText(singleLine, 0, 0)).toBe("fn noop() {}")
  })

  test("97. definition at end of file", () => {
    expect(ContextDefs.extractDefinitionText(lines, 5, 7)).toBe(
      "struct Bar {\n    field: i32,\n}",
    )
  })

  test("98. returns empty string if startLine > endLine", () => {
    expect(ContextDefs.extractDefinitionText(lines, 5, 3)).toBe("")
  })

  test("99. handles out-of-bounds endLine gracefully", () => {
    const result = ContextDefs.extractDefinitionText(lines, 5, 100)
    expect(result).toContain("struct Bar {")
    expect(result).toContain("}")
  })
})

describe("extractDocComment edge cases", () => {
  test("100. #[derive] between /// comment and def stops collection", () => {
    const lines = [
      "/// This is a doc comment",
      "#[derive(Debug)]",
      "struct Foo {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 2)).toBe(null)
  })

  test("101. #[allow] between // comment and def stops collection", () => {
    const lines = [
      "// some note",
      "#[allow(dead_code)]",
      "fn bar() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 2)).toBe(null)
  })

  test("102. multiple blank lines between comments still collected", () => {
    const lines = [
      "/// First",
      "",
      "",
      "/// Second",
      "fn foo() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 4)).toBe("/// First\n\n\n/// Second")
  })

  test("103. blank lines above with no comments above them stop", () => {
    const lines = [
      "fn other() {}",
      "",
      "",
      "fn foo() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 3)).toBe(null)
  })

  test("104. /** */ followed by /// collected together", () => {
    const lines = [
      "/** Block doc */",
      "/// Line doc",
      "fn foo() {}",
    ]
    expect(ContextDefs.extractDocComment(lines, 2)).toBe("/** Block doc */\n/// Line doc")
  })

  test("105. only whitespace line treated as blank", () => {
    const lines = [
      "/// Comment",
      "   ",
      "/// Another",
      "fn foo() {}",
    ]
    // Whitespace-only line is not blank (trimStart won't be empty for spaces... actually it will)
    // "   ".trimStart() === "" so this IS blank
    expect(ContextDefs.extractDocComment(lines, 3)).toBe("/// Comment\n   \n/// Another")
  })
})
