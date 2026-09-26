import type * as React from 'react';
import { cn } from '@/lib/utils';

// Chip surface from the AiPromptInput design (CHIP_SURFACE_CLASS), with tone variants for status.
export function Chip({
  children,
  tone = 'default',
  className,
  title,
}: {
  children: React.ReactNode;
  tone?: 'default' | 'soft' | 'good' | 'bad' | 'warn';
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium [&_svg]:size-3.5',
        tone === 'soft'
          ? 'text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]'
          : 'bg-muted text-foreground shadow-[inset_0_0_0_1px_rgba(123,123,123,0.12)]',
        tone === 'good' && 'text-good',
        tone === 'bad' && 'text-bad',
        tone === 'warn' && 'text-warn',
        className,
      )}
    >
      {children}
    </span>
  );
}

// Menu panel surface from the AiPromptInput design (MENU_PANEL_CLASS), used for inspector panels.
export const PANEL_CLASS = cn(
  'bg-popover text-popover-foreground rounded-2xl border-2 border-border p-3.5',
  'shadow-[0_8px_30px_-8px_rgba(0,0,0,0.45),0_2px_8px_-2px_rgba(0,0,0,0.3)]',
);

export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('text-muted-foreground/70 text-[10px] font-semibold tracking-wide uppercase', className)}>{children}</div>;
}
