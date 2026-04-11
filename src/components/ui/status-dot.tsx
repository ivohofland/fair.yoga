export type Status =
  | 'open'
  | 'open_full'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'draft'
  | 'below_min'
  | 'paid'
  | 'unpaid'
  | 'overdue';

interface StatusDotProps {
  status: Status;
  label?: string;
}

const colorMap: Record<Status, string> = {
  open: 'bg-teal',
  open_full: 'bg-gold',
  completed: 'bg-teal',
  paid: 'bg-teal',
  in_progress: 'bg-teal',
  draft: 'bg-brown',
  unpaid: 'bg-brown',
  cancelled: 'bg-error',
  below_min: 'bg-error',
  overdue: 'bg-error',
};

export function StatusDot({ status, label }: StatusDotProps) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${colorMap[status]}`}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  );
}
