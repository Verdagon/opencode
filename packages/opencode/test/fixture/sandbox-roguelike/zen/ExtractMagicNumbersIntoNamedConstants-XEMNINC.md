---
model: SimpleSmall
votes: 3
---
# Extract Magic Numbers Into Named Constants (EMNINC)

Avoid literal numbers and strings scattered in logic. Extract them to named constants at module or call site.

**Bad:**
```rust
if (goblin_index + 1) % 10 == 5 { ... }  // What does 5 mean?
let sight_range = 800;
if entity.allegiance == Allegiance::Evil { ... }
```

**Good:**
```rust
const PRIEST_EVERY_NTH_GOBLIN: usize = 10;
const PRIEST_OFFSET: usize = 5;
if (goblin_index + 1) % PRIEST_EVERY_NTH_GOBLIN == PRIEST_OFFSET { ... }

const DEFAULT_SIGHT_RANGE: i32 = 800;
```

# Clarifications (auto)

- Focus primarily on the `+` lines in the diff, but if you notice magic numbers in unchanged code within the same definition, flag those too.
- A literal on the right side of a `const` declaration is fine — that IS the extraction. Assigning a literal into a local `let` variable is NOT a valid fix; the value must be a module-level or associated `const`.
- Constants may be defined elsewhere in the file. The "Small Diff" section shows the full file diff; check there before concluding a constant is undefined.
- `0`, `1`, and `""` are never magic numbers. Incrementing/decrementing by 1 (`+ 1`, `- 1`), indexing with 1, comparisons against 1, and empty strings in `.expect("")` are all fine and should not be flagged. Similarly, `0` in comparisons like `hp <= 0`, `x >= 0`, boundary checks, and zero-initialization is fine.
- Magic numbers in `#[test]` functions are fine. Test code commonly uses inline fixture values (seeds, dimensions, thresholds) and these should not be flagged.
- String literals in `panic!`, `expect`, `unwrap_or_else`, and error messages are not magic strings. These are crash/error messages, not values used in logic.
