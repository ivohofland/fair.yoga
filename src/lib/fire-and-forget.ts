import type { Assert, Equals } from './type-pins';

/**
 * The return type of work that must never be awaited.
 *
 * `void`, deliberately. A function returning no promise cannot couple its
 * caller's response — status or latency — to work the caller must not wait
 * for, and `.then()` / `.catch()` on the result are compile errors rather
 * than review findings. That is a constraint the compiler applies at every
 * call site, present and future, instead of a discipline each caller has to
 * have read about first.
 *
 * The alias exists for what a bare `void` does not say: it names the contract
 * in the signature, where a reader meets it at the moment they would
 * otherwise reach for `await`. A function returning this owns its own
 * rejection path — there is no promise left for a caller to attach a `.catch`
 * to, so the logging belongs inside.
 *
 * Awaiting one is legal and inert: `await` on a non-promise yields a
 * microtask and nothing else, so the mistake costs a tick rather than
 * reopening anything. That is the point — the harmful version is
 * unrepresentable, so the harmless one needs no rule.
 *
 * `grep -rn '): FireAndForget' src/` enumerates every function carrying the
 * contract. Deliberately not a count: a number written here would be accurate
 * for one branch, the same argument `type-pins.ts` makes about its own
 * dependants.
 */
export type FireAndForget = void;

/**
 * The alias's own pin. The realistic regression is not a caller doing
 * something exotic — it is someone widening this alias back to
 * `Promise<void>` while refactoring, which silently restores the awaitable
 * shape every call site was protected by. That rewrite fails here.
 *
 * Honest about the limit, as `type-pins.ts` is about its own: this pins the
 * ALIAS. A function that stops using the alias and declares `Promise<void>`
 * directly is a separate hole, pinned separately at `deliverInvitation`
 * itself (`services/invitations.ts`).
 */
type _fireAndForgetIsVoid = Assert<Equals<FireAndForget, void>>;
void 0 as unknown as [_fireAndForgetIsVoid];
