import type { ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

// Pill buttons, 48px tall. One primary per screen; destructive is never filled.
const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'border-[1.5px] border-transparent bg-teal text-cream hover:bg-teal-hover active:bg-teal-pressed',
  secondary: 'border-[1.5px] border-teal text-teal bg-transparent hover:bg-teal-tint',
  ghost: 'border-[1.5px] border-transparent text-teal bg-transparent hover:bg-teal-tint',
  destructive:
    'border-[1.5px] border-danger text-danger bg-transparent hover:bg-danger-tint',
};

export function Button({
  variant = 'primary',
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-pill px-6 min-h-12 text-base font-semibold w-full sm:w-auto focus:outline-none focus-visible:shadow-focus';
  const disabledClass = disabled ? 'opacity-50 cursor-not-allowed' : '';

  return (
    <button
      className={`${base} ${variantClasses[variant]} ${disabledClass} ${className}`.trim()}
      disabled={disabled}
      {...props}
    />
  );
}
