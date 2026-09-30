import { useId, type InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

// 48px field on sand, radius 12, label above with 8px gap.
// Hint = caption between label and field. Error = danger border + danger-tint
// background + 13px message below.
export function Input({ label, error, hint, id, className = '', ...props }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
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
      {hint && (
        <span id={hintId} className="type-caption text-brown-light">
          {hint}
        </span>
      )}
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`border rounded-field px-4 min-h-12 text-ink text-base ${fieldColors} focus:outline-none focus:shadow-focus ${className}`.trim()}
        {...props}
      />
      {error && (
        <span
          id={errorId}
          role="alert"
          className="text-[13px] leading-[1.4] text-danger"
        >
          {error}
        </span>
      )}
    </div>
  );
}
