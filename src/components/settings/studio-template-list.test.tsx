import { describe, it, expect } from 'vitest';
import { render, screen, getNodeText } from '@testing-library/react';
import type { StudioClassTemplate } from '@prisma/client';
// The pure-JS Decimal — a component test must not pull in the query engine.
import { Decimal } from '@prisma/client/runtime/library';
import { StudioTemplateList } from './studio-template-list';

/**
 * #281. `StudioTemplateList` renders its active, paused, and archived
 * sections from one array, each with its own title expression and its own
 * caption expression — this file is what holds those three in agreement.
 *
 * Every case here renders ONE template so the query is unambiguous, and every
 * case asserts the same two things, because the risk this guards against is
 * divergence *between* the sections rather than any single section being
 * wrong.
 */
const base = {
  id: 't1',
  teacherId: 'teacher-1',
  classType: 'Vinyasa',
  dayOfWeek: 1,
  startTime: '09:00',
  durationMinutes: 60,
  location: 'Yoga Studio Centrum',
  hourlyRate: new Decimal(45),
  isActive: true,
  isArchived: false,
  archivedAt: null,
  withdrawnCount: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
} satisfies StudioClassTemplate;

const STATES = [
  { name: 'active', template: { ...base, isActive: true, isArchived: false } },
  { name: 'paused', template: { ...base, isActive: false, isArchived: false } },
  { name: 'archived', template: { ...base, isActive: false, isArchived: true } },
];

describe('StudioTemplateList — the three sections agree', () => {
  for (const { name, template } of STATES) {
    it(`titles a ${name} template with its class type`, () => {
      render(<StudioTemplateList templates={[template]} />);
      expect(screen.getByText('Vinyasa')).toBeDefined();
    });

    it(`keeps the location in a ${name} template's caption`, () => {
      render(<StudioTemplateList templates={[template]} />);
      expect(screen.getByText(/Yoga Studio Centrum · €45\.00\/hr/)).toBeDefined();
    });
  }

  it('titles with the location and keeps it in the caption when there is no class type', () => {
    render(<StudioTemplateList templates={[{ ...base, classType: '' }]} />);
    // With no class type, the title falls back to the location and the
    // caption still carries it — two distinct nodes. `getNodeText` matches
    // only direct child text nodes, so each `<span>` is addressable on its
    // own and the ancestor `<a>` (whose children are all elements) matches
    // neither query.
    const title = screen.getByText(
      (_, element) => element instanceof HTMLElement && getNodeText(element) === 'Yoga Studio Centrum'
    );
    expect(title.tagName).toBe('SPAN');

    const caption = screen.getByText(
      (_, element) => element instanceof HTMLElement && getNodeText(element) === 'Yoga Studio Centrum · €45.00/hr'
    );
    expect(caption.tagName).toBe('SPAN');
  });
});
