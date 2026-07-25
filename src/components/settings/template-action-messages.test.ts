import { describe, it, expect } from 'vitest';
import { pauseMessage, archiveMessage, archiveStudioMessage } from './template-action-messages';

describe('pauseMessage', () => {
  it('names the last still-scheduled date and time', () => {
    // Fixed date, not new Date() — 2026-08-17 is a Monday, so this also pins
    // formatDayHeader's UTC-accessor behavior rather than drifting with today.
    expect(pauseMessage({ date: new Date('2026-08-17T00:00:00.000Z'), startTime: '08:15' })).toBe(
      'No new classes will be added to your schedule. The last one still scheduled is Monday, Aug 17 · 08:15.',
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

  it('nothing deleted, one remaining — singular "class", no pronoun', () => {
    expect(archiveMessage(0, 1)).toBe(
      'No unbooked classes to delete. There are still 1 class on the schedule — cancel individually if needed.',
    );
  });

  it('nothing deleted, many remaining — plural "classes", no pronoun', () => {
    expect(archiveMessage(0, 3)).toBe(
      'No unbooked classes to delete. There are still 3 classes on the schedule — cancel individually if needed.',
    );
  });

  it('some deleted, nothing remaining — fully cleared', () => {
    expect(archiveMessage(4, 0)).toBe(
      'Classes on the schedule without bookings are now deleted. Nothing from this template is scheduled any more.',
    );
  });

  it('some deleted, one remaining — singular "class", no pronoun', () => {
    expect(archiveMessage(3, 1)).toBe(
      'Classes on the schedule without bookings are now deleted. There are still 1 class on the schedule — cancel individually if needed.',
    );
  });

  it('some deleted, many remaining — plural "classes", no pronoun', () => {
    expect(archiveMessage(2, 3)).toBe(
      'Classes on the schedule without bookings are now deleted. There are still 3 classes on the schedule — cancel individually if needed.',
    );
  });
});

describe('archiveStudioMessage', () => {
  it('nothing deleted — nothing was ever scheduled', () => {
    expect(archiveStudioMessage(0)).toBe('Nothing from this template was scheduled.');
  });

  it('one deleted — singular "class"', () => {
    expect(archiveStudioMessage(1)).toBe(
      'Deleted 1 scheduled studio class. Nothing from this template is scheduled any more.',
    );
  });

  it('many deleted — plural "classes"', () => {
    expect(archiveStudioMessage(3)).toBe(
      'Deleted 3 scheduled studio classes. Nothing from this template is scheduled any more.',
    );
  });
});
