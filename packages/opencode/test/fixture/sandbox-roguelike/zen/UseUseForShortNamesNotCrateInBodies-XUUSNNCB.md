---
model: SimpleSmall
votes: 3
---
# Use `use` for Short Names, Not `crate::` in Bodies (UUSNNCB)

Avoid `crate::module::Type` in function bodies. Add `use` at the top so types and functions have short names.

**Bad:**
```rust
game.levels[level_index].squads[crate::entity::Squad::new()];
let adjacent = crate::game::get_pattern_adjacent_locations(loc, true);
```

**Good:**
```rust
use crate::entity::Squad;
use crate::game::get_pattern_adjacent_locations;

game.levels[level_index].squads.push(Squad::new());
let adjacent = get_pattern_adjacent_locations(loc, true);
```

# Clarifications (auto)

- Focus primarily on the `+` lines in the diff, but if you notice `crate::` usage in unchanged code within the same definition, flag those too.
