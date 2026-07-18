The signature element on class cards: an 8px progress bar for registrations. Fill is danger until the minimum is met, teal after; a small ink tick marks the minimum. The label above right distinguishes the live count from the configured range: the count is prominent (16px semibold, teal once the minimum is met, brown before), the "/ 6–14" range sits beside it as quiet 12px brown — reading "8, of a class set for 6–14".

```jsx
<RegistrationProgress registered={8} min={6} max={14} />
```
