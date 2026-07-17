import { useId, type InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

// 48px field on sand, radius 12, label above with 8px gap.
// Error = danger border + danger-tint background + 13px message below.
export function Input({ label, error, id, className = '', ...props }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const fieldColors = error
    ? 'border-danger bg-danger-tint'
    : 'border-border bg-sand-soft';

  return (
    <div className="flex flex-col gap-2">
      {label && (
        <label htmlFor={inputId} className="type-label">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`border rounded-field px-4 min-h-12 text-ink text-base ${fieldColors} focus:outline-none focus:shadow-focus ${className}`.trim()}
        {...props}
      />
      {error && <span className="text-[13px] leading-[1.4] text-danger">{error}</span>}
    </div>
  );
}
