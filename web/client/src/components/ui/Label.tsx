import type { LabelHTMLAttributes } from 'react';

export function Label({ className = '', ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={`label ${className}`.trim()} {...rest} />;
}
