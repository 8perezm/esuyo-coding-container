import type { ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className = '', type = 'button', ...rest }: ButtonProps) {
  const variantClass = variant === 'primary' ? 'btn-primary' : 'btn-secondary';
  return <button type={type} className={`btn ${variantClass} ${className}`.trim()} {...rest} />;
}
