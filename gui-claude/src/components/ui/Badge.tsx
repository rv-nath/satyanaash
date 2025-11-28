import React from 'react';
import { cn } from '../../lib/utils';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'success' | 'error' | 'warning' | 'info' | 'neutral';
}

export function Badge({ className, variant = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm px-2 py-1 text-xs font-medium',
        {
          'bg-success-50 text-success-600': variant === 'success',
          'bg-error-50 text-error-600': variant === 'error',
          'bg-warning-50 text-warning-600': variant === 'warning',
          'bg-primary-50 text-primary-600': variant === 'info',
          'bg-neutral-100 text-neutral-600': variant === 'neutral',
        },
        className
      )}
      {...props}
    />
  );
}
