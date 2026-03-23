---
model: SimpleSmall
votes: 3
---
# No Global State Anywhere (NGSA)

All code (production code, test code, and tooling) must avoid global state.

## Rule (Strict)

- Do not mutate or depend on global state (for example: process current working directory, global env vars, shared temp paths, singleton mutable caches).
- Do not introduce methods that interact with global state, even if they look convenient.
- Pass explicit context instead (for example: `repo_path`, config structs, scoped temp directories).

## Why

- Parallel execution can interleave and overwrite assumptions.
- This causes flaky, non-deterministic failures that are hard to debug.

## Practical Guidance

- Never call `set_current_dir`.
- Do not read/write process-global env vars from core logic.
- Do not use shared mutable singletons for runtime behavior.
- Run subprocesses with explicit `current_dir`.
- Use per-operation unique temp directories.
- Keep all code paths deterministic and context-explicit.

# Clarifications (auto)

- Focus primarily on the `+` lines in the diff, but if you notice global state in unchanged code within the same definition, flag those too.
- This check covers process-wide mutable singletons (`static mut`, global env vars). Filesystem reads and stderr writes are not global state.
