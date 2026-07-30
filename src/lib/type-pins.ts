/**
 * Compile-time invariant pins.
 *
 * A pin is a type that resolves to `true` when an invariant holds and to the
 * offending member's name when it does not, asserted via
 * `const _x: NoneOf<…> = true; void _x;`. The const is what instantiates the
 * conditional type — a pin alias that nothing assigns is never evaluated and
 * reports nothing, so deleting the const/void pair removes the check silently.
 */

/**
 * `true` when `T` is `never`, and `T` itself otherwise — so a failed pin names
 * the offender instead of failing as a bare boolean.
 *
 * The tuple brackets are load-bearing here in a way they were not at the call
 * sites this replaces, where the argument was always a concrete alias. `T` is a
 * naked type parameter, so unbracketed `T extends never` would distribute, and
 * distribution over the empty union is `never`. The failure mode is the
 * counter-intuitive direction: `NoneOf<never>` — the case where the invariant
 * HOLDS — would resolve to `never` and reject `true`, leaving the build
 * permanently red with no offending field to name. Measured on TypeScript
 * 5.9.3: unbracketed, only the passing case breaks; both forms still reject one
 * and two offenders correctly.
 *
 * Before the fixture below existed, defanging the body to
 * `[T] extends [T] ? true : T` kept `T` referenced (so lint stayed green) and
 * kept `tsc` at exit 0, while letting a `status` field reach `updateMany` with
 * every pin still reporting success. With the fixture in place that rewrite no
 * longer keeps `tsc` at exit 0 — see `_noneOfHoldsIsTrue` below, which that
 * rewrite fails.
 */
export type NoneOf<T extends PropertyKey> = [T] extends [never] ? true : T;

/**
 * `NoneOf`'s own pin. Every pin in the repo resolves through this one alias —
 * service modules and `'use client'` components alike — so a hollowed-out
 * `NoneOf` defangs all of them at once, and the call sites cannot catch that,
 * because every one of them instantiates `NoneOf<never>` and so only exercises
 * the passing direction.
 *
 * Deliberately not a count. `grep -rn ': NoneOf<' src/` is current; a number
 * written here was accurate for one branch and has been wrong ever since. What
 * matters is the shape of the blast radius, not its size this week: the
 * dependants are load-bearing invariants, and none of them can vouch for the
 * alias they are written in.
 *
 * These assert *resolution identity*, not merely that `true` is rejected. That
 * distinction is load-bearing and was learned the hard way: the first version
 * of this fixture used `@ts-expect-error`, which a body of
 * `[T] extends [never] ? true : 'INVARIANT VIOLATED'` satisfies happily while
 * destroying the "names the offender" property every pin's comment depends on.
 * `Equals` catches that; non-assignability does not.
 *
 * Honest about the limit: no finite fixture is a proof. A body written to
 * special-case exactly these three inputs would pass. That is not the threat —
 * the threat is a contributor hollowing the alias out while refactoring, and
 * these catch every such rewrite we could construct.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

// Invariant holds -> `true`, so the assertion const in each pin compiles.
type _noneOfHoldsIsTrue = Assert<Equals<NoneOf<never>, true>>;
// Invariant broken -> the offender itself, so the build names the field.
type _noneOfNamesOneOffender = Assert<Equals<NoneOf<'x'>, 'x'>>;
// Two offenders must not collapse — this is what the tuple brackets buy.
type _noneOfNamesTwoOffenders = Assert<Equals<NoneOf<'x' | 'y'>, 'x' | 'y'>>;
void 0 as unknown as [_noneOfHoldsIsTrue, _noneOfNamesOneOffender, _noneOfNamesTwoOffenders];
