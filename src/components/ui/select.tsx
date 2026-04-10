import { useId, type SelectHTMLAttributes } from 'react';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
}

export function Select({ label, error, id, className = '', children, ...props }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={selectId} className="text-brown">
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={`bg-cream border border-teal rounded-none px-4 pr-10 py-3 min-h-[44px] text-dark focus:outline-none focus:shadow-[inset_0_0_0_1px_var(--color-teal)] w-full appearance-none bg-[length:16px_16px] bg-[position:right_12px_center] bg-no-repeat bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A//www.w3.org/2000/svg'%20viewBox%3D'0%200%2024%2024'%20fill%3D'none'%20stroke%3D'%236B5B4E'%20stroke-width%3D'2'%3E%3Cpath%20d%3D'M6%209l6%206%206-6'/%3E%3C/svg%3E")] ${className}`.trim()}
        {...props}
      >
        {children}
      </select>
      {error && <span className="text-sm text-error">{error}</span>}
    </div>
  );
}
