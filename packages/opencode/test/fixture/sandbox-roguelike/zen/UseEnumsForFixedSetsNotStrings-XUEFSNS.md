---
model: SimpleSmall
votes: 3
---
# Use Enums for Fixed Sets, Not Strings (UEFSNS)

When a value is from a fixed set (tile types, display classes, allegiance), use an enum. String matching is error-prone and refactor-unfriendly.

**Bad:**
```rust
match tile.display_class.as_str() {
    "dirt" => { ... }
    "grass" => { ... }
    "wall" => { ... }
    _ => panic!("unrecognized tile display class"),
}
```

**Good:**
```rust
#[derive(Clone, Copy)]
pub enum TileKind { Dirt, Grass, Wall }
impl Tile { pub fn display_char(&self) -> char { ... } }
```

# Clarifications (auto)

- Focus primarily on the `+` lines in the diff, but if you notice string usage for fixed sets in unchanged code within the same definition, flag those too.
- This check is about using strings to represent fixed sets of values. Do not flag compile errors, borrow checker issues, or other unrelated correctness problems.
