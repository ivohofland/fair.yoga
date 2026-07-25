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
 */
export type NoneOf<T> = [T] extends [never] ? true : T;
