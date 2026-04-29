import { useId, type InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, id, className = '', ...props }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className="flex flex-col gap-2">
      {label && (
        <label htmlFor={inputId} className="font-heading italic text-[13px] text-brown">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`bg-cream border border-brown rounded-none px-4 py-3 min-h-[44px] text-dark text-base focus:outline-none focus:shadow-[inset_0_0_0_1px_var(--color-brown)] ${className}`.trim()}
        {...props}
      />
      {error && <span className="font-heading italic text-[12px] text-error">{error}</span>}
    </div>
  );
}
