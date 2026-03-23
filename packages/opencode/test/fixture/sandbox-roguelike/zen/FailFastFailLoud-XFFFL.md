---
model: SimpleSmall
votes: 3
---
# Error Handling Philosophy (FFFL)

## Core Principle: Fail Fast, Fail Loud

This codebase follows an **aggressive fail-fast** approach to error handling.

## What This Means

### DO:
- **Propagate every error immediately** using `?` or explicit error returns
- **Panic or return `Err` on any unexpected condition**
- **Halt execution the moment something goes wrong**
- **Make errors visible and impossible to ignore**
- **Use `expect()` or `unwrap()` to crash on unexpected conditions**
- **Treat warnings as errors** - if something is wrong enough to log, it's wrong enough to stop

### NEVER:
- **Never silently fail** - no swallowing errors
- **Never log and continue** - logging is not error handling
- **Never gracefully degrade** - no fallback behavior
- **Never use default values on error** - no `unwrap_or_default()`
- **Never catch and ignore** - every error must bubble up
- **Never "best effort"** - either succeed completely or fail completely

## Why?

1. **Correctness over convenience**: A program that continues with corrupted state is worse than one that stops
2. **Debuggability**: Failures close to the source are easier to debug than cascading failures later
3. **No silent corruption**: Better to crash than produce wrong results
4. **Clear contracts**: Functions either succeed completely or fail completely - no partial success
5. **Force explicit decisions**: If someone wants to handle an error, make them write explicit code for it

## Examples

```rust
// GOOD: Propagate immediately
fn process_data(path: &str) -> Result<Data> {
    let content = std::fs::read_to_string(path)?;
    let data = parse_data(&content)?;
    Ok(data)
}

// GOOD: Panic on invariant violation
fn get_session_id(events: &[Event]) -> String {
    for event in events {
        if let Event::StepStart { session_id } = event {
            return session_id.clone();
        }
    }
    panic!("No StepStart event found - this should never happen! Events: {:?}", events);
}

// GOOD: Panic on impossible state
fn divide(a: i32, b: i32) -> i32 {
    if b == 0 {
        panic!("Division by zero - caller violated contract");
    }
    a / b
}

// BAD: Log and continue
fn process_data(path: &str) -> Data {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to read file: {}", e);
            return Data::default(); // WRONG: silently using default
        }
    };
    // ...
}

// BAD: Graceful degradation
fn get_config() -> Config {
    load_config().unwrap_or_else(|_| {
        // WRONG: hiding the error
        Config::default()
    })
}

// GOOD: Fail immediately
fn get_config() -> Result<Config> {
    load_config() // Propagate error, let caller decide
}
```

## Exceptions

There are **no exceptions** to this rule. If you think you've found one, you're wrong.

## Corollary

If a function returns `Result`, **every call site must handle it** with `?` or explicit matching. Never use `unwrap()` in production code paths (tests are fine).

If you find yourself wanting to log and continue, ask: "Is this program still correct if this operation failed?" If the answer is anything other than "yes, completely," then fail instead.

## Summary

**When in doubt, crash.** Silent failures are bugs waiting to happen. Loud failures are bugs you can fix.

# Clarifications (auto)

- Focus primarily on the `+` lines in the diff, but if you notice error handling violations in unchanged code within the same definition, flag those too.
- This check is about error handling philosophy only: swallowing errors, logging-and-continuing, returning defaults on failure. Do not flag compile errors, borrow checker issues, type mismatches, or other correctness problems — those are not FFFL violations.
- Do NOT flag the quality of `expect()`, `panic!()`, or `unwrap()` messages. Messages like `""`, `"wat"`, `"unimplemented"`, or any other string are all fine. The important thing is that the code crashes — what the message says is irrelevant to this check.
