interface RetentionNoteProps {
  /** `start` (default): left-aligned, with its own top padding, under a
   * non-empty list's rows. `center`: centred with no top padding of its
   * own, for placing directly under `EmptyState`, inside that component's
   * padded envelope rather than opening a second one below it. */
  align?: 'start' | 'center';
}

/** The inbox's retention policy, under the list (#223). */
export function RetentionNote({ align = 'start' }: RetentionNoteProps) {
  return (
    <p className={`type-caption ${align === 'center' ? 'text-center' : 'pt-4'}`}>
      Messages are kept for a year.
    </p>
  );
}
