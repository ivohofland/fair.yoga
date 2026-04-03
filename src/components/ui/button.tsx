import type { ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'destructive';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-teal text-cream',
  secondary: 'border border-teal text-teal bg-transparent',
  destructive: 'border border-error text-error bg-transparent',
};

export function Button({
  variant = 'primary',
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  const base = 'rounded-lg px-6 py-3 font-medium min-h-[44px]';
  const disabledClass = disabled ? 'opacity-50 cursor-not-allowed' : '';

  return (
    <button
      className={`${base} ${variantClasses[variant]} ${disabledClass} ${className}`.trim()}
      disabled={disabled}
      {...props}
    />
  );
}
