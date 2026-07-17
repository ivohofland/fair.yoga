interface RunningHeaderProps {
  pageLabel: string;
}

export function RunningHeader({ pageLabel }: RunningHeaderProps) {
  return (
    <div className="fy-running-header mb-6">
      <span className="wordmark">fair.yoga</span>
      <span className="opacity-70">{pageLabel}</span>
    </div>
  );
}
