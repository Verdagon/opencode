---
model: SimpleSmall
votes: 3
---
# TODOS + unimplemented code MUST panic (TUCMP)

If you must leave todos or unimplemented things, ensure they panic (or assert) with a unique message that will make it immediately clear when failures are from not-yet-brought-over code.

# Clarifications (auto)

- Focus primarily on the `+` lines in the diff, but if you notice TODOs or unimplemented code in unchanged code within the same definition, flag those too.
- This check is specifically about TODO comments and unimplemented/placeholder code that should panic. Do not flag struct field additions, incomplete APIs, or missing call-site updates — those are not TUCMP violations.
- A panic message containing "unimplemented" (case-insensitive) is acceptable, e.g. `panic!("Unimplemented")`. The message does not need to be highly specific.
