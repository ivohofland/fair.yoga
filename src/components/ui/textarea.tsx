import { useId, type TextareaHTMLAttributes } from 'react';

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

// Multi-line sibling of Input: same sand field, radius 12, label above.
export function Textarea({ label, error, id, className = '', ...props }: TextareaProps) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;
  const fieldColors = error
    ? 'border-danger bg-danger-tint'
    : 'border-border bg-sand-soft';

  return (
    <div className="flex flex-col gap-2">
      {label && (
        <label htmlFor={textareaId} className="type-label">
          {label}
        </label>
      )}
      <textarea
        id={textareaId}
        className={`border rounded-field px-4 py-3 min-h-24 text-ink text-base ${fieldColors} focus:outline-none focus:shadow-focus ${className}`.trim()}
        {...props}
      />
      {error && <span className="text-[13px] leading-[1.4] text-danger">{error}</span>}
    </div>
  );
}
