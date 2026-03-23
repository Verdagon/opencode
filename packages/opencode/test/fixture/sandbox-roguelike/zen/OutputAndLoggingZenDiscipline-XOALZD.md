---
model: SimpleSmall
votes: 3
---
# Output And Logging Zen Discipline (OALZD)

All output from the program falls into exactly two categories: **log-only** or **print-and-log**. There is no third option.

## Rule (Strict)

- **Never use `println!` or `eprintln!` directly** in production code.
- Every piece of output must go through a helper such as `log` or `log_and_print`.
- Everything that is printed must also be logged; everything that is logged does not need to be printed.

## The Two Options

1. **Log only** – Use `log(&logger, message)` when the output is for debugging/audit and should not clutter stdout.
2. **Print and log** – Use `log_and_print(&logger, message)` when the user should see it and it should also appear in the log files.

## Why

- **Audit trail**: Every output is recorded in log files for debugging and reproducibility.
- **Scriptability**: stdout can stay focused on user-facing summaries when verbose output is log-only.
- **Consistency**: Centralized helpers keep behavior uniform (timestamps, flushing, paths).
- **No orphan output**: Direct `println!` bypasses logging and creates output that cannot be traced in logs.

## Path Argument

- **Always pass the path in** to every logging helper.
- **Never hardcode the path** (e.g. `"0"` or `""`). Use a path variable from the call site.
- **Never supply `""`** except from a top-level entry point (main, test harness, etc.). Only the entry point may decide that the path is empty; all other code must receive path from their caller and pass it through.
- `get_path_logger` and logging helpers may receive `""` as a value, but the caller must pass a variable—never a hardcoded `""` literal.

## Practical Guidance

- Prefer `log` for progress, step details, and responses—print only concise summaries.
- Use `log_and_print` for final results, user prompts, and critical status.
- In `main.rs`, use the provided helpers or pass a logger; do not `println!` for flow-related output.
- If you need to add a new output site, add a logger parameter and use the appropriate helper.

# Clarifications (auto)

- Focus primarily on the `+` lines in the diff, but if you notice `println!`/`eprintln!` usage in unchanged code within the same definition, flag those too.
- This check is about output discipline only: using direct print macros instead of logging helpers. Do not flag unrelated issues.
