/** Static sand skeleton block — loading = skeletons matching layout. */
export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  /** Corner radius; match the element being replaced (16 for a card). */
  radius?: number;
  style?: React.CSSProperties;
}
