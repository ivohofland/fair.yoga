/**
 * Canonical wire API response types (#206).
 *
 * Route handlers construct response payloads that flow through `respondTyped<T>`
 * to guarantee that response literals satisfy these contracts at compile time.
 * Client components and action-message formatters consume these types.
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
 * The `data` payload of a successful PATCH on a *studio* class template (#119, #206).
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

export type StudioTemplateCreateResponse = TemplateCreateResponse;

/**
 * The prediction fields carried on the `data` payload of a successful PUT editing
 * a recurring class template (#194, #206).
 *
 * `firstEffective` is an ISO string on the wire (or null if the template is not eligible).
 */
export interface TemplateEditResponse {
  firstEffective: string | null;
  generationState: TemplateGenerationState;
}

// Compile-time pins asserting that the class and studio toggle response types
// remain non-interchangeable via `templateKind` (#204, #206).
type _classIsNotStudio = Assert<Equals<TemplateToggleResponse extends StudioTemplateToggleResponse ? true : false, false>>;
type _studioIsNotClass = Assert<Equals<StudioTemplateToggleResponse extends TemplateToggleResponse ? true : false, false>>;
void 0 as unknown as [_classIsNotStudio, _studioIsNotClass];
