import { describe, it, expect } from 'vitest';
import type { ClassFamily, ClassTemplate, StudioClassTemplate } from '@prisma/client';
import type { TemplateFamily } from './rule-lifecycle';
import { CLASS_FAMILY } from './class-template-lifecycle';
import { STUDIO_FAMILY } from './studio-class-template-lifecycle';

/**
 * Every family this repo has, as a union.
 *
 * Named rather than written as `TemplateFamily<never>`: `TChild` appears in
 * `withSlot`'s return position, so `TemplateFamily<ClassTemplate>` is not
 * assignable to `TemplateFamily<never>` and that spelling does not compile.
 * Measured, not reasoned.
 */
type AnyTemplateFamily =
  | TemplateFamily<ClassTemplate>
  | TemplateFamily<StudioClassTemplate>;

/**
 * A third `ClassFamily` variant becomes a compile error HERE rather than a
 * silent gap — the tether `COUNT_KEYS` (`template-action-messages.ts`) and
 * `ROOM_SEARCH_SELECT` (`api/rooms/route.ts`) use, applied to families.
 *
 * The value type is `AnyTemplateFamily`, not `unknown`, and the difference is
 * measured rather than stylistic: with `unknown` this object accepts
 * `{ regular: CLASS_FAMILY, studio: 42 }` without complaint. Both spellings
 * catch a MISSING key; only this one catches a half-defined family, which is
 * the failure the tether exists for.
 *
 * `prisma/schema.prisma`'s own `ClassFamily` docblock anticipates a third
 * variant, which is why this is worth having rather than hypothetical.
 */
const FAMILY_BY_KIND = {
  regular: CLASS_FAMILY,
  studio: STUDIO_FAMILY,
} satisfies Record<ClassFamily, AnyTemplateFamily>;

describe('rule-lifecycle family descriptors', () => {
  it('each descriptor declares the kind it is filed under', () => {
    for (const [kind, family] of Object.entries(FAMILY_BY_KIND)) {
      expect(family.kind).toBe(kind);
    }
  });

  it('the family without a withdraw hook says so explicitly rather than omitting it', () => {
    // `null`, not `undefined`. `TemplateFamily.withdraw` is required, so an
    // omission is a compile error — this asserts the runtime half: that the
    // studio descriptor has actually made the choice rather than inherited it.
    expect(STUDIO_FAMILY.withdraw).toBeNull();
    expect(CLASS_FAMILY.withdraw).not.toBeNull();
  });
});
