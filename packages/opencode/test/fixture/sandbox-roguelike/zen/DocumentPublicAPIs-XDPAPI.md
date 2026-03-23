---
model: SimpleSmall
votes: 3
---
# Document Public APIs (DPAPI)

Public functions and public fields, especially those with non-obvious behavior, should have doc comments. Include preconditions, postconditions, and error cases.

**Bad:** Many public functions have no docs. `get_locations_within_sight` has a long inline comment explaining diagonal distance—that belongs in a doc comment.

**Good:**
```rust
/// Returns visible locations using diagonal Manhattan distance. Locations are explored
/// in straight-as-possible order; walls block sight past them.
pub fn get_locations_within_sight(...)
```

# Clarifications (auto)

- Focus primarily on the `+` lines in the diff, but if you notice undocumented public functions or fields in unchanged code within the same definition, flag those too.
- A doc comment of any length or detail counts — as long as `///` is present, the item passes. Do not flag items for insufficient detail in their doc comment.
