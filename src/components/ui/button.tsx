import type { ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-brown text-cream hover:opacity-80 focus:bg-brown/50 focus:shadow-[inset_0_0_0_2px_var(--color-brown)]',
  secondary: 'border border-brown text-brown bg-transparent hover:opacity-80 focus:shadow-[inset_0_0_0_2px_var(--color-brown)]',
  ghost: 'text-brown bg-transparent hover:opacity-80 focus:shadow-[inset_0_0_0_2px_var(--color-brown)]',
  destructive: 'border border-error text-error bg-transparent hover:opacity-80 focus:shadow-[inset_0_0_0_2px_var(--color-error)]',
};

export function Button({
  variant = 'primary',
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  const base = 'rounded-none px-6 py-3 font-medium min-h-[44px] w-full sm:w-auto cursor-pointer focus:outline-none';
  const disabledClass = disabled ? 'opacity-50 cursor-not-allowed' : '';

  return (
    <button
      className={`${base} ${variantClasses[variant]} ${disabledClass} ${className}`.trim()}
      disabled={disabled}
      {...props}
    />
  );
}
