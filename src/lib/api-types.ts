/**
 * Canonical wire API response types (#206).
 *
 * Response payload contracts for routes migrated to compile-time response type
 * checking under #206 (currently class-template and studio-class-template
 * lifecycle endpoints).
 *
 * Scoped to response payloads only — distinct from request-body validation
 * schemas in `@/lib/schemas`. Route handlers construct response payloads that flow
 * through `respondTyped<T>` to guarantee that response literals satisfy these
 * contracts at compile time. Client components and action-message formatters
 * consume these types.
 */

import type { SkipCounts } from '@/lib/generation';
import type { TemplateGenerationState } from '@/lib/template-selection';
import type { Assert, Equals } from '@/lib/type-pins';

/**
 * The `data` payload of a successful PATCH on a class template (#206).
 *
 * Wire representation: `date` in `lastScheduled` is an ISO string (post-JSON
 * serialization), matching what the client receives and what `resolveTemplateConfirmation`
 * parses.
 *
 * The `scheduled?: never; added?: never` phantom on the old collapsed `active`
 * arm did this job until the class family's resume gained counts of its own —
 * the case this design predicted. No phantom can separate two structurally
 * identical arms, so `templateKind` is the discriminator instead: it is a
 * literal on the `active` arm of each family's type, checkable at runtime
 * (which the phantom was not), and both resolvers already distrust the wire.
 * A union is assignable only if every arm is, so one non-assignable arm still
 * protects the whole type in both directions — that is what the compile-time
 * pin below asserts, and swapping a resolver for its sibling fails on
 * `templateKind`'s literal rather than compiling clean the way the phantom
 * let it (#93, #119, #206).
 */
export type TemplateToggleResponse =
  | { action: 'paused'; lastScheduled: { date: string; startTime: string } | null }
  | { action: 'archived'; deleted: number; remaining: number }
  | {
      action: 'active';
      templateKind: 'class';
      scheduled: number;
      added: number;
      counts: SkipCounts;
    }
  | { action: 'unarchived' | 'unchanged' };

/**
 * The `data` payload of a successful PATCH on a *studio* class template (#93, #119, #206).
 *
 * Differs from `TemplateToggleResponse` in `templateKind: 'studio'`.
 */
export type StudioTemplateToggleResponse =
  | { action: 'paused'; lastScheduled: { date: string; startTime: string } | null }
  | { action: 'archived'; deleted: number; remaining: number }
  | {
      action: 'active';
      templateKind: 'studio';
      scheduled: number;
      added: number;
      counts: SkipCounts;
    }
  | { action: 'unarchived' | 'unchanged' };

/**
 * The reporting fields carried on the `data` payload of a successful POST creating
 * a recurring class template (#196, #206).
 */
export interface TemplateCreateResponse {
  added: number;
  counts: SkipCounts;
}

/**
 * The reporting fields carried on the `data` payload of a successful POST creating
 * a recurring studio class template (#196, #206).
 *
 * Structurally identical to `TemplateCreateResponse` today because both creation
 * services report the same generation metrics (`added` + `counts`). Unlike the
 * PATCH toggle response pair, the wire payload does not carry a `templateKind`
 * discriminator; callers distinguish families via the enclosing endpoint and the
 * Prisma model fields (`ClassTemplate` vs `StudioClassTemplate`) intersecting this shape.
 */
export type StudioTemplateCreateResponse = TemplateCreateResponse;

/**
 * The prediction fields carried on the `data` payload of a successful PUT editing
 * a recurring class template (#194, #206).
 *
 * `firstEffective` is an ISO string on the wire (Monday of the first week the
 * new schedule reaches), or `null` when there is no such week to name (#194/#284).
 * `null` has two distinct causes (represented alongside via `generationState`):
 * either no free week is inside the probe's horizon, or the template is not
 * currently eligible to generate (e.g. paused or archived).
 */
export interface TemplateEditResponse {
  firstEffective: string | null;
  generationState: TemplateGenerationState;
}

// Compile-time pins asserting that the class and studio toggle response types
// remain non-interchangeable via `templateKind` (#93, #119, #206).
type _classIsNotStudio = Assert<Equals<TemplateToggleResponse extends StudioTemplateToggleResponse ? true : false, false>>;
type _studioIsNotClass = Assert<Equals<StudioTemplateToggleResponse extends TemplateToggleResponse ? true : false, false>>;
void 0 as unknown as [_classIsNotStudio, _studioIsNotClass];
