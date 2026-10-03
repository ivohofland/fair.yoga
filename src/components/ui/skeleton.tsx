export type SkeletonSurface = 'page' | 'card';

/** The six type utilities, so a placeholder line borrows a real line's height. */
export type TypeStyle =
  | 'type-display'
  | 'type-title'
  | 'type-subtitle'
  | 'type-body'
  | 'type-label'
  | 'type-caption';

// sand-soft disappears on a sand-soft card, so a bar on a card takes the
// next sand step.
const SURFACE_BG: Record<SkeletonSurface, string> = {
  page: 'bg-sand-soft',
  card: 'bg-sand',
};

/** The surface's own fill class, for a placeholder that isn't a `Skeleton` rectangle (e.g. a real element's frame with invisible text/border standing in for color). */
export function surfaceFill(surface: SkeletonSurface): string {
  return SURFACE_BG[surface];
}

interface SkeletonProps {
  className?: string;
  surface?: SkeletonSurface;
}

// A content placeholder — a number, an icon slot — inside a primitive's
// frame. Never a stand-in for a whole card or row: those come from the
// primitive's own *Skeleton (docs/design-brief.md, Loading states).
// Static sand: no shimmer, no spinner.
export function Skeleton({ className = '', surface = 'page' }: SkeletonProps) {
  return <div aria-hidden="true" className={`${SURFACE_BG[surface]} rounded-[4px] ${className}`.trim()} />;
}

interface SkeletonTextProps {
  type: TypeStyle;
  /** A Tailwind width class for the bar, e.g. "w-2/5". */
  width: string;
  surface?: SkeletonSurface;
  className?: string;
}

// One line of placeholder text. The block carries the type utility, so its
// line box is that style's line-height; the bar inside is shorter than the
// line and centred, so it never sets the height itself.
export function SkeletonText({ type, width, surface = 'page', className = '' }: SkeletonTextProps) {
  return (
    <div aria-hidden="true" className={`${type} ${className}`.trim()}>
      <span className={`inline-block align-middle h-[0.8em] rounded-[4px] ${SURFACE_BG[surface]} ${width}`} />
    </div>
  );
}
