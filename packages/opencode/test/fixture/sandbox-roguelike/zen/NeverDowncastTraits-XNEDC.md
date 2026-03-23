---
model: SimpleSmall
votes: 3
---
# Never Downcast Traits (NEDC)

Downcasting a trait object to a concrete type is always an abstraction violation. If you need to know the concrete type, the abstraction is not doing its job.

**Never use `downcast_ref`, `downcast_mut`, `std::any::Any`, or `TypeId` to inspect or recover a concrete type from a trait object.** If you find yourself writing this, the trait is missing a method.

A trait is a promise: "I don't care what you are, only what you can do." The moment you downcast, you break that promise -- callers become secretly coupled to a specific implementation, adding a second implementation silently breaks things, and there's no compile-time enforcement of the real contract. The `else` branch that immediately fails is a clear sign the abstraction is fake:

```rust
// BAD
if let Some(r) = (deps.llm as &dyn std::any::Any).downcast_ref::<OpencodeRequester>() {
    let llm_clone = OpencodeRequester::new(r.cwd.clone(), r.model.clone());
} else {
    bail!("Parallel only supported with OpencodeRequester"); // the abstraction is a lie
}
```

When you feel the urge to downcast, ask: "What does the caller actually need?" Then add that to the trait -- or satisfy it through supertrait bounds. For example, needing to share the requester across threads just requires `Send + Sync` on the trait; scoped threads can then borrow `&dyn LlmRequester` directly with no type inspection and no cloning:

```rust
// GOOD
pub trait LlmRequester: Send + Sync {
    fn request_stream(&self, ...) -> ...;
}
```

Common rationalizations that don't hold up: "only one implementation exists right now" (the downcast makes it impossible to add a second without hunting down every cast site); "the concrete type has fields the trait doesn't expose" (expose them through the trait); "it's just a one-time check" (one-time checks accumulate, and the second downcast is always easier to add because the first already set the precedent).

# Clarifications (auto)

- Focus primarily on the `+` lines in the diff, but if you notice downcasts in unchanged code within the same definition, flag those too.
