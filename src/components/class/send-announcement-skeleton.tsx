import { SkeletonText, type TypeStyle } from '@/components/ui/skeleton';

// The collapsed trigger's type style, shared by `SendAnnouncement`'s button
// and its skeleton.
export const TRIGGER_TYPE: TypeStyle = 'type-label';

// The collapsed state: one line in the trigger's type style, `inline-block`
// so it joins its wrapper's line box the way the button it stands for does —
// both are inline-level. The wrapper's own strut (its inherited line-height,
// from the page body, taller than type-label's own) sets the floor height.
// A block placeholder would drop out of that line box and render at
// type-label's own, shorter line-height instead.
export function SendAnnouncementSkeleton() {
  return <SkeletonText type={TRIGGER_TYPE} width="w-36" className="inline-block" />;
}
