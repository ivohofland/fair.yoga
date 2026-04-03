import type { InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, id, className = '', ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="text-sm text-brown">
          {label}
        </label>
      )}
      <input
        id={id}
        className={`bg-sand border border-border rounded-lg px-4 py-3 min-h-[44px] text-dark focus:border-teal focus:outline-none ${className}`.trim()}
        {...props}
      />
      {error && <span className="text-sm text-error">{error}</span>}
    </div>
  );
}
