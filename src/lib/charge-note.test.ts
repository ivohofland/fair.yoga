import { describe, it, expect } from 'vitest';
import { LATE_CANCEL_CHARGE_NOTE, lateCancelNoteFor } from './charge-note';

describe('lateCancelNoteFor (#912)', () => {
  it('names no charge on a donation class (#912)', () => {
    expect(lateCancelNoteFor('donation')).toBe('Cancelled after the deadline.');
  });

  it('keeps the tiered charge note (#912)', () => {
    expect(lateCancelNoteFor('tiered')).toBe(LATE_CANCEL_CHARGE_NOTE);
  });
});
