import { describe, it, expect } from 'vitest';
import { bookingPath, classShareState } from './class-share';

const start = new Date('2026-11-03T17:30:00Z');
describe('bookingPath', () => {
  it('is the class booking page', () => {
    expect(bookingPath('anna', 'c1')).toBe('/anna/book/c1');
  });
});
describe('classShareState', () => {
  it('shares an open class before its start', () => {
    expect(classShareState({ status: 'open', cancelled: false, start }, new Date(start.getTime() - 1))).toBe('share');
  });
  it('stops at the start instant even while the status still reads open', () => {
    expect(classShareState({ status: 'open', cancelled: false, start }, start)).toBe('none');
  });
  it('asks a draft to publish first', () => {
    expect(classShareState({ status: 'draft', cancelled: false, start }, new Date(0))).toBe('publish_first');
  });
  it('offers nothing on a cancelled class', () => {
    expect(classShareState({ status: 'open', cancelled: true, start }, new Date(0))).toBe('none');
    expect(classShareState({ status: 'draft', cancelled: true, start }, new Date(0))).toBe('none');
  });
  it('offers nothing in progress or completed', () => {
    expect(classShareState({ status: 'in_progress', cancelled: false, start }, new Date(0))).toBe('none');
    expect(classShareState({ status: 'completed', cancelled: false, start }, new Date(0))).toBe('none');
  });
});
