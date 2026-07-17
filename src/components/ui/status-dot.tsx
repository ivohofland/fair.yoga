export type DotShape = 'ring' | 'half' | 'filled';

interface StatusDotProps {
  shape: DotShape;
  label?: string;
}

export function StatusDot({ shape, label }: StatusDotProps) {
  const base = 'inline-block w-[9px] h-[9px] rounded-full';
  const shapeClass =
    shape === 'ring'
      ? 'border-[1.5px] border-brown bg-transparent'
      : shape === 'half'
        ? 'border border-brown'
        : 'bg-brown';

  const halfFillStyle =
    shape === 'half'
      ? { background: 'linear-gradient(to right, var(--color-brown) 50%, transparent 50%)' }
      : {};

  return (
    <span
      className={`${base} ${shapeClass}`}
      style={{ transform: 'translateY(-1px)', ...halfFillStyle }}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  );
}

export function deriveDotShape(
  registrations: number,
  minStudents: number,
  maxStudents: number,
): DotShape {
  if (registrations >= maxStudents) return 'filled';
  if (registrations >= minStudents) return 'half';
  return 'ring';
}
