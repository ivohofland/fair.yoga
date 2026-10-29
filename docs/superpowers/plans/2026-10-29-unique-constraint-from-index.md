# Read the 23505 constraint name from the adapter's index (#923)

**Goal.** A unique violation's constraint name comes from the adapter's
structured `cause.constraint.index`, as `23503`'s already does. Postgres's
primary message is read only when that field is absent. With the field
present, a localised or reworded `23505` message no longer turns the 409s that
unique violations back into 500s.

**Direction.** The owner's recommendation on #923: structured first, message
fallback. `23514` and `23P01` stay message-parsed: their `postgres`-kind cause
carries no `constraint`.

**Premise, as measured.**

- `@prisma/adapter-pg@7.10.1` `mapDriverError`, `case "23505"`: it writes
  `constraint = { index: error.constraint }` when pg's `DatabaseError` names
  one, and otherwise `{ fields }` parsed from `detail`. Re-derive with
  `grep -n 'case "23505"' -A20 node_modules/@prisma/adapter-pg/dist/index.js`.
- Postgres names the index on every btree unique violation
  (`_bt_check_unique` calls `errtableconstraint` with the index name).
- No migration raises `23505` by hand: `grep -rn "23505\|unique_violation" prisma/migrations`
  returns nothing. So only a `{ fields }`-only or adapter-regressed cause reaches
  the fallback.

## Task 1: the reader and its pins

Files: `src/lib/pg-error.ts`, `src/lib/pg-error.test.ts`.

- Factor `23503`'s reader into an `indexOf(cause)` helper. `23505` becomes the
  index first, then the anchored message clause. The composed reader is still
  registered as a message reader, so `namesConstraintInMessage('23505')` stays
  true and `constraintUnparsed` still fires when neither source names it.
- Fabricated tests:
  - A `23505` with `constraint.index` and a localised message is named from
    the index.
  - The index wins over a message naming another constraint.
  - A `{ fields }`-only cause falls back to the message.
  - A cause with neither source answers no name.
- Real-DB test: every produced `23505` case asserts that its cause carries
  `constraint: { index: <name> }`, and that the name survives replacing
  `originalMessage` with a localised one. Without that pin, an adapter
  regression would be hidden by the fallback.
- **Prove it bites:** revert `23505` to the message-only reader. The localised
  fabricated case and the real-DB localised case must go red. Record the
  error, then restore.

## Task 2: header and docs

Files: `src/lib/pg-error.ts` (header docblock), `docs/technical-architecture.md`
("Database errors": the `CONSTRAINT_SOURCE` table and the paragraph after it,
"Locale and Postgres major", and the `constraintUnparsed` bullet).

- State the `23505` source as structured with a message fallback. Replace the
  "all three name matches share one source" rationale rather than annotate it.
- Narrow the locale exposure to `23514`/`23P01`, plus `23505` only on the
  fallback.
- Sweep for the words "three clauses", "all three", and
  `23505/23514/23P01` across `src/`, `docs/` and `tests/`.
