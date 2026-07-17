import { useId, type SelectHTMLAttributes } from 'react';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
}

export function Select({ label, error, id, className = '', children, ...props }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const fieldColors = error
    ? 'border-danger bg-danger-tint'
    : 'border-border bg-sand-soft';

  return (
    <div className="flex flex-col gap-2">
      {label && (
        <label htmlFor={selectId} className="type-label">
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={`border rounded-field px-4 pr-10 min-h-12 text-ink text-base ${fieldColors} focus:outline-none focus:shadow-focus w-full appearance-none bg-[length:16px_16px] bg-[position:right_12px_center] bg-no-repeat bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A//www.w3.org/2000/svg'%20viewBox%3D'0%200%2024%2024'%20fill%3D'none'%20stroke%3D'%236B5B4E'%20stroke-width%3D'1.75'%3E%3Cpath%20d%3D'M6%209l6%206%206-6'/%3E%3C/svg%3E")] ${className}`.trim()}
        {...props}
      >
        {children}
      </select>
      {error && <span className="text-[13px] leading-[1.4] text-danger">{error}</span>}
    </div>
  );
}
