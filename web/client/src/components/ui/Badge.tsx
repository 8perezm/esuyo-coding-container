import type { HTMLAttributes } from 'react';

type BadgeTone = 'default' | 'accent' | 'violet';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = 'default', className = '', ...rest }: BadgeProps) {
  const toneClass = tone === 'accent' ? 'badge-accent' : tone === 'violet' ? 'badge-violet' : '';
  return <span className={`badge ${toneClass} ${className}`.trim()} {...rest} />;
}
