import { describe, it, expect } from 'vitest';
import {
  pauseMessage,
  archiveMessage,
  archiveStudioMessage,
  resolveTemplateConfirmation,
  resolveStudioConfirmation,
  resumeMessage,
  resumeStudioMessage,
  templateUpdatedMessage,
  UNARCHIVE_MESSAGE,
  type StudioTemplateToggleResponse,
  type TemplateToggleResponse,
} from './template-action-messages';

describe('pauseMessage', () => {
  it('names the last still-scheduled date and time', () => {
    // Fixed date, not new Date() — 2026-08-17 is a Monday, so this also pins
    // formatDayHeader's UTC-accessor behavior rather than drifting with today.
    expect(pauseMessage({ date: new Date('2026-08-17T00:00:00.000Z'), startTime: '08:15' })).toBe(
      'No new classes will be added to your schedule. The last one still scheduled is Monday, 17 Aug · 08:15.',
    );
  });

  it('says nothing is currently scheduled when there is no last instance', () => {
    expect(pauseMessage(null)).toBe(
      'No new classes will be added to your schedule. Nothing from this template is currently scheduled.',
    );
  });
});

describe('archiveMessage', () => {
  it('nothing deleted, nothing remaining — nothing was ever scheduled', () => {
    expect(archiveMessage(0, 0)).toBe('Nothing from this template was scheduled.');
  });

  /**
   * "Nothing was withdrawn", not "No unbooked classes to delete": the survivor
   * this branch reports is often today's class, which *is* unbooked and was
   * spared by the delete's boundary rather than by anyone booking it. The old
   * wording contradicted the count in its own sentence.
   */
  it('nothing deleted, one remaining — singular "class", no pronoun, no verb', () => {
    expect(archiveMessage(0, 1)).toBe(
      'Nothing was withdrawn. 1 class still on the schedule — cancel individually if needed.',
    );
  });

  it('nothing deleted, many remaining — plural "classes", no pronoun, no verb', () => {
    expect(archiveMessage(0, 3)).toBe(
      'Nothing was withdrawn. 3 classes still on the schedule — cancel individually if needed.',
    );
  });

  it('some deleted, nothing remaining — fully cleared', () => {
    expect(archiveMessage(4, 0)).toBe(
      'Classes on the schedule without bookings are now deleted. Nothing from this template is scheduled any more.',
    );
  });

  it('some deleted, one remaining — singular "class", no pronoun, no verb', () => {
    expect(archiveMessage(3, 1)).toBe(
      'Classes on the schedule without bookings are now deleted. 1 class still on the schedule — cancel individually if needed.',
    );
  });

  it('some deleted, many remaining — plural "classes", no pronoun, no verb', () => {
    expect(archiveMessage(2, 3)).toBe(
      'Classes on the schedule without bookings are now deleted. 3 classes still on the schedule — cancel individually if needed.',
    );
  });
});

describe('archiveStudioMessage', () => {
  it('nothing deleted, nothing remaining — nothing was ever scheduled', () => {
    expect(archiveStudioMessage(0, 0)).toBe('Nothing from this template was scheduled.');
  });

  it('nothing deleted, one remaining — singular "class", no pronoun, no verb', () => {
    expect(archiveStudioMessage(0, 1)).toBe(
      '1 class still on the schedule — cancel individually if needed.',
    );
  });

  it('nothing deleted, many remaining — plural "classes", no pronoun, no verb', () => {
    expect(archiveStudioMessage(0, 3)).toBe(
      '3 classes still on the schedule — cancel individually if needed.',
    );
  });

  it('some deleted, nothing remaining — fully cleared, singular "class"', () => {
    expect(archiveStudioMessage(1, 0)).toBe(
      'Deleted 1 scheduled studio class. Nothing from this template is scheduled any more.',
    );
  });

  it('some deleted, nothing remaining — fully cleared, plural "classes"', () => {
    expect(archiveStudioMessage(3, 0)).toBe(
      'Deleted 3 scheduled studio classes. Nothing from this template is scheduled any more.',
    );
  });

  it('some deleted, one remaining — singular "class" on both counts, no pronoun, no verb', () => {
    expect(archiveStudioMessage(1, 1)).toBe(
      'Deleted 1 scheduled studio class. 1 class still on the schedule — cancel individually if needed.',
    );
  });

  it('some deleted, many remaining — plural "classes" on both counts, no pronoun, no verb', () => {
    expect(archiveStudioMessage(2, 3)).toBe(
      'Deleted 2 scheduled studio classes. 3 classes still on the schedule — cancel individually if needed.',
    );
  });
});

describe('resolveTemplateConfirmation', () => {
  it('returns the pause message when the template was paused', () => {
    expect(
      resolveTemplateConfirmation({
        action: 'paused',
        lastScheduled: { date: '2026-06-12T00:00:00.000Z', startTime: '09:30' },
      }),
    ).toBe(
      'No new classes will be added to your schedule. The last one still scheduled is Friday, 12 Jun · 09:30.',
    );
  });

  it('returns the archive message when the template was archived', () => {
    expect(resolveTemplateConfirmation({ action: 'archived', deleted: 2, remaining: 1 })).toBe(
      'Classes on the schedule without bookings are now deleted. 1 class still on the schedule — cancel individually if needed.',
    );
  });

  /**
   * All five numbers distinct, for the reason the studio sibling below records
   * about the first two: equal values make a transposition invisible. That rule
   * was added for `scheduled`/`added` after a measured live slip and was not
   * extended when `blockedByCancelled`/`slotTaken` arrived — so swapping
   * arguments 3 and 4 at this resolver's call site left the whole unit suite
   * green. `alreadyThisWeek` (#194) is the fifth and keeps the rule: unequal to
   * all four of the others, so a swap with any of them changes this string.
   */
  it('returns the class resume message for an active payload', () => {
    expect(
      resolveTemplateConfirmation({
        action: 'active',
        templateKind: 'class',
        scheduled: 4,
        added: 3,
        counts: { blockedByCancelled: 2, slotTaken: 1, alreadyThisWeek: 5, blockedByOverlap: 0 },
      }),
    ).toBe(
      '4 classes on your schedule. 1 date already had a class. 2 cancelled classes still hold those dates. 5 dates are still held by classes on your previous day.',
    );
  });

  /**
   * The wire guard, one count over. `alreadyThisWeek` is the newest field on
   * this arm, so a tab holding this bundle against a server that predates it
   * receives an `active` payload without it — and an unguarded
   * `${undefined} dates are still held…` is what the four older counts already
   * have a test against. Silence is the contract for a payload this resolver
   * cannot read.
   */
  it('says nothing rather than rendering undefined when the NEWEST count is missing', () => {
    // The newest count is `blockedByOverlap` (#296), not `alreadyThisWeek`
    // (#194) — this fixture dropped the latter until PR review, so it stopped
    // testing the newest-count path the moment a newer count existed, while its
    // title went on claiming it did. That is the whole failure mode: a fixture
    // pinned to an ordinal rather than to a name.
    //
    // It is also the case that was BROKEN when review found it:
    // `hasIntegerCounts` checked three of four members, so this payload passed
    // the guard and narrowed to `SkipCounts` on a lie.
    const wire = {
      action: 'active',
      templateKind: 'class',
      scheduled: 4,
      added: 0,
      counts: { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0 },
    } as unknown as TemplateToggleResponse;
    expect(resolveTemplateConfirmation(wire)).toBeNull();
  });

  it('says nothing when any OTHER single count is missing', () => {
    // One case per member, so no member can be the untested one — the ordinal
    // trap above, closed structurally. `COUNT_KEYS` makes the guard exhaustive
    // at compile time; this makes it exhaustive at runtime too.
    const full = {
      blockedByCancelled: 0,
      slotTaken: 0,
      alreadyThisWeek: 0,
      blockedByOverlap: 0,
    };
    for (const missing of Object.keys(full)) {
      const counts = Object.fromEntries(
        Object.entries(full).filter(([key]) => key !== missing),
      );
      const wire = {
        action: 'active',
        templateKind: 'class',
        scheduled: 4,
        added: 0,
        counts,
      } as unknown as TemplateToggleResponse;
      expect(resolveTemplateConfirmation(wire), `missing ${missing}`).toBeNull();
    }
  });

  it('says nothing for the studio resolver on the same partial payload', () => {
    // The studio side had no partial-payload case at all — only a
    // counts-absent one — so the shared guard was pinned from one family only.
    const wire = {
      action: 'active',
      templateKind: 'studio',
      scheduled: 4,
      added: 0,
      counts: { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0 },
    } as unknown as StudioTemplateToggleResponse;
    expect(resolveStudioConfirmation(wire)).toBeNull();
  });

  /**
   * The failure mode nesting introduced, and the reason `hasIntegerCounts`
   * checks the object before its members: three flat fields read `undefined`
   * and failed `Number.isInteger`, where three members of a missing object
   * THROW. A rolled-back server sending `{ action: 'active' }` is the payload
   * that reaches this, and an exception here would take the whole button's
   * click handler with it rather than falling back to silence.
   */
  it('says nothing rather than throwing when the counts object is absent entirely', () => {
    const wire = {
      action: 'active',
      templateKind: 'class',
      scheduled: 4,
      added: 0,
    } as unknown as TemplateToggleResponse;
    expect(() => resolveTemplateConfirmation(wire)).not.toThrow();
    expect(resolveTemplateConfirmation(wire)).toBeNull();
  });

  /**
   * `unchanged` is what a stale second tab and a retry-after-lost-response
   * reach, so captioning it at all would describe something that did not
   * happen — the #98 bug wearing a different hat. It is the only silent
   * action left: `active` used to be listed here, and `unarchived` until
   * #116; both speak now, and each has its own test pinning its message.
   */
  it('says nothing for unchanged', () => {
    expect(resolveTemplateConfirmation({ action: 'unchanged' })).toBeNull();
  });

  /**
   * The literal, not the constant. Comparing against `UNARCHIVE_MESSAGE` pins
   * which ARM answers and nothing about what it says — measured, rewording the
   * constant to the studio's "This template is paused" passed this file and
   * both component files. That is precisely the regression the constant's own
   * docblock singles out, so the string is spelled out here the way
   * `resolveStudioConfirmation`'s twin spells out its own.
   */
  it('speaks on un-archive for the class family', () => {
    expect(resolveTemplateConfirmation({ action: 'unarchived' })).toBe(
      'Un-archived. This recurring class is paused — resume it to put classes back on your schedule.',
    );
    // Still the exported constant, so a caller importing it gets the same text.
    expect(UNARCHIVE_MESSAGE).toBe(
      'Un-archived. This recurring class is paused — resume it to put classes back on your schedule.',
    );
  });
});

describe('resolveStudioConfirmation', () => {
  it('returns the pause message when the template was paused', () => {
    expect(
      resolveStudioConfirmation({
        action: 'paused',
        lastScheduled: { date: '2026-06-12T00:00:00.000Z', startTime: '09:30' },
      }),
    ).toBe(
      'No new classes will be added to your schedule. The last one still scheduled is Friday, 12 Jun · 09:30.',
    );
  });

  it('returns the studio archive message when the template was archived', () => {
    expect(resolveStudioConfirmation({ action: 'archived', deleted: 2, remaining: 1 })).toBe(
      'Deleted 2 scheduled studio classes. 1 class still on the schedule — cancel individually if needed.',
    );
  });

  /**
   * `scheduled: 4, added: 0` deliberately, not 4/4. This is the only test that
   * drives `resumeStudioMessage`'s argument order at its production call site,
   * and with equal numbers a transposition is invisible — PR review measured
   * exactly that: swapping the two arguments in `resolveStudioConfirmation`
   * left `tsc` clean and all 42 tests across the three importing files green.
   * Transposed, this case now reads 'Nothing is scheduled from this template.'
   * Keep the two numbers unequal.
   */
  it('returns the resume message, with the arguments in the order it passes them', () => {
    // All five distinct — see the class sibling above. Two unequal numbers
    // caught a transposition of arguments 1 and 2; it took four to catch one of
    // 3 and 4, which passed 43/43 until this fixture changed. `alreadyThisWeek`
    // is 0 in production here until #284 (see this resolver's `active` case),
    // and is non-zero in this FIXTURE for exactly the same reason the others
    // are unequal: a value that is always 0 pins no position.
    expect(
      resolveStudioConfirmation({
        action: 'active',
        templateKind: 'studio',
        scheduled: 4,
        added: 3,
        counts: { blockedByCancelled: 2, slotTaken: 1, alreadyThisWeek: 5, blockedByOverlap: 0 },
      }),
    ).toBe(
      '4 classes on your schedule. 1 date already had a class. 2 cancelled classes still hold those dates. 5 dates are still held by classes on your previous day.',
    );
  });

  /**
   * The type says `scheduled`/`added` are `number`, but both buttons reach the
   * resolver through an unchecked `as` on `res.json()` — so a tab holding this
   * bundle against a rolled-back server gets `{ action: 'active' }` with no
   * counts. Without the guard the template literal renders "undefined classes
   * on your schedule."
   */
  it('says nothing rather than rendering undefined when the counts are missing', () => {
    const wire = { action: 'active' } as unknown as StudioTemplateToggleResponse;
    expect(resolveStudioConfirmation(wire)).toBeNull();
  });

  it('reports that un-archiving left the template paused', () => {
    expect(resolveStudioConfirmation({ action: 'unarchived' })).toBe(
      'Un-archived. This template is paused — resume it to put classes back on your schedule.',
    );
  });

  // `unchanged` alone now. `active` speaks (#119) and so does `unarchived` —
  // un-archiving forces `isActive: false`, so silence there let a teacher leave
  // the page believing a class was restored when the template is paused with an
  // empty window. `unchanged` is what a stale second tab and a
  // retry-after-lost-response reach, so captioning it would describe something
  // that did not happen. Its class-family sibling still lists three.
  it.each(['unchanged'] as const)('says nothing for %s', (action) => {
    expect(resolveStudioConfirmation({ action })).toBeNull();
  });
});

describe('resumeStudioMessage', () => {
  it('reports the window when the resume filled it', () => {
    expect(resumeStudioMessage(4, 4, { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe('4 classes on your schedule.');
  });

  it('says nothing needed adding when the window was already full', () => {
    expect(resumeStudioMessage(0, 4, { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe(
      '4 classes on your schedule. Nothing needed adding.',
    );
  });

  it('reports a short window without claiming why it is short', () => {
    expect(resumeStudioMessage(2, 2, { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe('2 classes on your schedule.');
  });

  it('agrees in number at one class', () => {
    expect(resumeStudioMessage(1, 1, { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe('1 class on your schedule.');
    expect(resumeStudioMessage(0, 1, { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe(
      '1 class on your schedule. Nothing needed adding.',
    );
  });

  it('names a taken slot rather than leaving a smaller number unexplained', () => {
    expect(resumeStudioMessage(3, 4, { blockedByCancelled: 0, slotTaken: 1, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe(
      '4 classes on your schedule. 1 date already had a class.',
    );
  });

  it('names the cancelled classes still holding an empty window', () => {
    expect(resumeStudioMessage(0, 0, { blockedByCancelled: 4, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe(
      'Nothing is scheduled from this template. 4 cancelled classes still hold those dates.',
    );
  });

  it('stays silent about cause when there is none to name', () => {
    expect(resumeStudioMessage(0, 0, { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe('Nothing is scheduled from this template.');
  });

  // The argument order is delta-first to match `archiveStudioMessage` even
  // though the sentence leads with the second argument, so the two outputs must
  // stay distinguishable — otherwise nothing anywhere could detect a swap.
  //
  // This pins the *function's* parameter order and nothing more. Its title used
  // to end "so a transposed call site cannot pass", which was false: the call
  // site lives in `resolveStudioConfirmation`, and transposing it there passed
  // this test and every other one. The guard that does bite is the unequal
  // fixture in `resolveStudioConfirmation`'s own test above.
  it('distinguishes its two arguments', () => {
    expect(resumeStudioMessage(0, 4, { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 })).not.toBe(resumeStudioMessage(4, 0, { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 }));
  });
});

describe('resumeMessage (class)', () => {
  it('says nothing extra when the window filled', () => {
    expect(resumeMessage(4, 4, { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe('4 classes on your schedule.');
  });

  it('names a taken slot rather than leaving a smaller number unexplained', () => {
    expect(resumeMessage(3, 4, { blockedByCancelled: 0, slotTaken: 1, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe(
      '4 classes on your schedule. 1 date already had a class.',
    );
  });

  it('names the cancelled classes still holding an empty window', () => {
    expect(resumeMessage(0, 0, { blockedByCancelled: 4, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe(
      'Nothing is scheduled from this template. 4 cancelled classes still hold those dates.',
    );
  });

  it('stays silent about cause when there is none to name', () => {
    expect(resumeMessage(0, 0, { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe('Nothing is scheduled from this template.');
  });

  // The singular was unreachable by the pins above, which only ever passed 4.
  // It read "1 cancelled class still hold those dates" — a verb after the
  // count, the shape `archiveMessage`'s docblock warns about.
  it('agrees with its verb when a single cancelled class holds a date', () => {
    expect(resumeMessage(0, 0, { blockedByCancelled: 1, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe(
      'Nothing is scheduled from this template. 1 cancelled class still holds that date.',
    );
  });

  // `scheduled` counts only draft/open, so live and cancelled dates coexist in
  // one window. Naming only the taken slot here is the silence #192 was filed
  // about.
  it('names both causes on a window that has each', () => {
    expect(resumeMessage(0, 2, { blockedByCancelled: 1, slotTaken: 1, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe(
      '2 classes on your schedule. 1 date already had a class. 1 cancelled class still holds that date.',
    );
  });

  it('names the cancelled dates even when some classes are scheduled', () => {
    expect(resumeMessage(0, 2, { blockedByCancelled: 2, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe(
      '2 classes on your schedule. 2 cancelled classes still hold those dates.',
    );
  });

  // Reachable, and it said nothing until the causes were assembled before the
  // empty-window branch: every candidate date held by another of this teacher's
  // classes. `slotTaken` was measured correctly and then discarded.
  it('names the taken slots on an empty window, not just the cancelled ones', () => {
    expect(resumeMessage(0, 0, { blockedByCancelled: 0, slotTaken: 4, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe(
      'Nothing is scheduled from this template. 4 dates already had a class.',
    );
  });

  it('names both causes on an empty window that has each', () => {
    expect(resumeMessage(0, 0, { blockedByCancelled: 2, slotTaken: 2, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe(
      'Nothing is scheduled from this template. 2 dates already had a class. 2 cancelled classes still hold those dates.',
    );
  });

  // `slotTaken > 1` was unreached — every fixture used 0 or 1 — so replacing
  // the plural branch with a bare 'date' shipped "2 date already had a class."
  it('pluralises the taken-slot count', () => {
    expect(resumeMessage(1, 4, { blockedByCancelled: 0, slotTaken: 3, alreadyThisWeek: 0, blockedByOverlap: 0 })).toBe(
      '4 classes on your schedule. 3 dates already had a class.',
    );
  });

  // #194's own failure at half the number, and the reason this count is
  // carried at all: a teacher who moves Tuesday→Thursday and resumes has four
  // Tuesdays holding the four weeks, so without this clause the sentence reads
  // "4 classes on your schedule. Nothing needed adding." about four classes on
  // the weekday they just abandoned.
  it('names the weeks the previous day still holds', () => {
    expect(resumeMessage(0, 4, { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 4, blockedByOverlap: 0 })).toBe(
      '4 classes on your schedule. 4 dates are still held by classes on your previous day.',
    );
  });

  // Its own inflection, like the cancelled clause and unlike the slot one:
  // "is/are" and "a class/classes" both change with number, where "had" does
  // not. That is the trap this file's `resumeMessage` docblock records.
  it('agrees with its verb when a single date is held by the previous day', () => {
    expect(resumeMessage(0, 4, { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 1, blockedByOverlap: 0 })).toBe(
      '4 classes on your schedule. 1 date is still held by a class on your previous day.',
    );
  });

  // Clause ORDER, pinned with all three causes non-zero and all three counts
  // distinct: slotTaken, blockedByCancelled, alreadyThisWeek. The new one is
  // last so every sentence pinned above keeps the prefix it already had.
  it('orders the three causes: taken slots, cancelled holds, previous day', () => {
    expect(resumeMessage(0, 4, { blockedByCancelled: 2, slotTaken: 1, alreadyThisWeek: 3, blockedByOverlap: 0 })).toBe(
      '4 classes on your schedule. 1 date already had a class. 2 cancelled classes still hold those dates. 3 dates are still held by classes on your previous day.',
    );
  });

  // The empty-window head takes the clause too — the causes are assembled
  // before the `scheduled === 0` branch, for the reason that branch records.
  it('names the previous day on an empty window as well', () => {
    expect(resumeMessage(0, 0, { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 2, blockedByOverlap: 0 })).toBe(
      'Nothing is scheduled from this template. 2 dates are still held by classes on your previous day.',
    );
  });

  /**
   * The `blockedByOverlap` clause (#296), NEUTRAL since #327.
   *
   * It used to name the other family — "held by a studio class" for a class
   * template, "one of your own classes" for a studio one — on a condition that
   * was then "the other family holds this exact minute". #327 replaced the
   * two per-family slot keys with one RANGE constraint over both, so the
   * reason a generator raises now also covers a SAME-family class that merely
   * overlaps: a teacher with a Tuesday 19:00 template and a one-off ordinary
   * class at 20:00 on one of those Tuesdays was told a studio class held the
   * date, and had none. The sentence has to be true for every condition the
   * reason carries, so it names none of them.
   *
   * Asserted as whole sentences rather than `toContain`: the wording is what
   * this is about, and a substring check would pass a sentence that had
   * silently regained a family.
   */
  it('names no family, because the reason no longer identifies one', () => {
    expect(
      resumeMessage(0, 4, {
        blockedByCancelled: 0,
        slotTaken: 0,
        alreadyThisWeek: 0,
        blockedByOverlap: 2,
      }),
    ).toBe('4 classes on your schedule. 2 dates overlap other classes on your schedule.');
  });

  it('says it in the singular for one date', () => {
    expect(
      resumeMessage(0, 4, {
        blockedByCancelled: 0,
        slotTaken: 0,
        alreadyThisWeek: 0,
        blockedByOverlap: 1,
      }),
    ).toBe('4 classes on your schedule. 1 date overlaps another class on your schedule.');
  });

  it('orders the overlap clause after the three that predate it', () => {
    // The cause order is `slotTaken`, `blockedByCancelled`, `alreadyThisWeek`,
    // then this one. Pinned because the order is a copy decision, not an
    // accident of how the `if`s happen to be stacked.
    expect(
      resumeMessage(0, 4, {
        blockedByCancelled: 2,
        slotTaken: 1,
        alreadyThisWeek: 3,
        blockedByOverlap: 4,
      }),
    ).toBe(
      '4 classes on your schedule. 1 date already had a class. 2 cancelled classes still hold those dates. 3 dates are still held by classes on your previous day. 4 dates overlap other classes on your schedule.',
    );
  });
});

describe('the overlap clause claims no family on either side', () => {
  // Both directions of the mistake #327 made reachable, pinned as the exact
  // words rather than as a difference between the two functions — there is no
  // difference to assert any more, and asserting one would re-create the split
  // this deleted.
  it('does not tell a class-template teacher that a studio class holds the date', () => {
    const msg = resumeMessage(0, 4, {
      blockedByCancelled: 0,
      slotTaken: 0,
      alreadyThisWeek: 0,
      blockedByOverlap: 2,
    });
    expect(msg).not.toContain('studio');
  });

  it('does not tell a studio-template teacher that one of their own classes does', () => {
    // On the studio side the neighbouring `slotTaken` clause ("N dates already
    // had a class") already means another STUDIO class, so a clause saying
    // "your own classes" was distinguishing two things it could not tell apart.
    const msg = resumeStudioMessage(0, 4, {
      blockedByCancelled: 0,
      slotTaken: 0,
      alreadyThisWeek: 0,
      blockedByOverlap: 2,
    });
    expect(msg).toBe('4 classes on your schedule. 2 dates overlap other classes on your schedule.');
    expect(msg).not.toContain('your own');
  });
});

describe('the two families resume with one sentence', () => {
  // WHOLE again. #296 narrowed this to "except where they must not" by giving
  // the `blockedByOverlap` clause a per-family wording; #327 made that wording
  // neutral, because the reason stopped identifying a family. So the cases
  // below carry NON-ZERO `blockedByOverlap` values too — under the narrowed
  // claim those were the counter-examples, and under this one they are the
  // newest thing worth agreeing about.
  it('answers identically for every case pinned above', () => {
    // The fifth column is `alreadyThisWeek` (#194). It is 0 in production on
    // the studio side until #284 gives that generator a producer for the
    // reason — but the two functions must still answer identically when it is
    // not, or the delegation has a hole exactly where the newest count lives.
    const cases: Array<[number, number, number, number, number, number]> = [
      [4, 4, 0, 0, 0, 0],
      [0, 4, 0, 0, 0, 0],
      [3, 4, 0, 1, 0, 0],
      [0, 0, 4, 0, 0, 0],
      [0, 0, 1, 0, 0, 0],
      [0, 2, 1, 1, 0, 0],
      [0, 0, 0, 4, 0, 0],
      [0, 0, 2, 2, 0, 0],
      [1, 1, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
      [0, 4, 0, 0, 4, 0],
      [0, 4, 0, 0, 1, 0],
      [0, 4, 2, 1, 3, 0],
      [0, 0, 0, 0, 2, 0],
      [0, 4, 0, 0, 0, 2],
      [0, 4, 0, 0, 0, 1],
      [0, 4, 2, 1, 3, 4],
    ];
    for (const [added, scheduled, blocked, taken, thisWeek, overlap] of cases) {
      const counts = {
        blockedByCancelled: blocked,
        slotTaken: taken,
        alreadyThisWeek: thisWeek,
        blockedByOverlap: overlap,
      };
      expect(resumeStudioMessage(added, scheduled, counts)).toBe(
        resumeMessage(added, scheduled, counts),
      );
    }
  });
});

describe('templateUpdatedMessage', () => {
  it('names the week the change first takes effect', () => {
    // The argument is always a MONDAY (the probe converts before returning),
    // so `formatDayHeader` renders "Monday, 21 Sep" and the sentence reads
    // "the week starting Monday, 21 Sep".
    expect(templateUpdatedMessage(new Date('2026-09-21T00:00:00.000Z'), 'active')).toBe(
      'Template updated. It takes effect for newly generated classes — your first class on the new schedule is the week starting Monday, 21 Sep. Change existing classes individually if needed.',
    );
  });

  it('drops the middle clause when no free week is in view', () => {
    expect(templateUpdatedMessage(null, 'active')).toBe(
      'Template updated. It takes effect for newly generated classes. Change existing classes individually if needed.',
    );
  });

  /**
   * The two ineligible states, and the reason they are two sentences rather
   * than one (#194). The sweep selects on `ACTIVE_TEMPLATE_WHERE`, so neither
   * a paused nor an archived template is ever reached — and before this
   * argument existed, both rendered the DATED sentence above, naming a week
   * nothing would fill, for every such edit.
   *
   * The Monday is still passed in both cases, deliberately: these arms must
   * answer from `generationState` alone. A resolver that fell back to
   * `firstEffective` when it happened to be non-null would pass a test that
   * only ever handed it `null`, and the service's own gate would then be the
   * single point of failure for a sentence rendered on the client.
   */
  it('names the resume, not a week, for a paused recurring class', () => {
    expect(templateUpdatedMessage(new Date('2026-09-21T00:00:00.000Z'), 'paused')).toBe(
      'Template updated. It takes effect for newly generated classes — this recurring class is paused, so nothing is generated until you resume it. Change existing classes individually if needed.',
    );
  });

  /**
   * "un-archive AND resume", never "un-archive" alone.
   * `archiveOrUnarchiveTemplate` forces `isActive: false` on BOTH directions,
   * which is precisely what `UNARCHIVE_MESSAGE` (pinned above) exists to warn
   * about — so a sentence that stopped at un-archiving would send the teacher
   * to a paused template with an empty window and contradict the message they
   * are about to read there.
   */
  it('names the un-archive and the resume for an archived recurring class', () => {
    expect(templateUpdatedMessage(new Date('2026-09-21T00:00:00.000Z'), 'archived')).toBe(
      'Template updated. It takes effect for newly generated classes — this recurring class is archived, so nothing is generated until you un-archive and resume it. Change existing classes individually if needed.',
    );
  });

  // The remedy each ineligible sentence names must match the one
  // `UNARCHIVE_MESSAGE` gives, or a teacher gets two different instructions
  // for the same template within one page. Both say "resume"; only the
  // archived one adds the step before it.
  it('agrees with UNARCHIVE_MESSAGE about what un-archiving does not do', () => {
    expect(UNARCHIVE_MESSAGE).toContain('resume it');
    expect(templateUpdatedMessage(null, 'archived')).toContain('un-archive and resume it');
    expect(templateUpdatedMessage(null, 'paused')).toContain('resume it');
    expect(templateUpdatedMessage(null, 'paused')).not.toContain('un-archive');
  });
});

describe('the two toggle payloads are not interchangeable', () => {
  it('rejects a studio payload at the class resolver', () => {
    const studio: StudioTemplateToggleResponse = {
      action: 'active',
      templateKind: 'studio',
      scheduled: 4,
      added: 0,
      counts: { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 },
    };
    // @ts-expect-error studio payloads must never satisfy the class resolver
    resolveTemplateConfirmation(studio);
    // and the reverse
    const cls: TemplateToggleResponse = {
      action: 'active',
      templateKind: 'class',
      scheduled: 4,
      added: 0,
      counts: { blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOverlap: 0 },
    };
    // @ts-expect-error class payloads must never satisfy the studio resolver
    resolveStudioConfirmation(cls);
    expect(true).toBe(true);
  });
});
