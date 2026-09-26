import { motion } from 'framer-motion';
import { CodeIcon, FileTextIcon, XIcon } from 'lucide-react';
import type { Attachment } from '@/lib/attachments';
import { kb } from '@/lib/format';
import { cn } from '@/lib/utils';

export function AttachmentTile({ file, onRemove, className }: { file: Attachment; onRemove?: () => void; className?: string }) {
  const remove = onRemove ? (
    <button
      type="button"
      aria-label={`Remove ${file.name}`}
      onClick={onRemove}
      className="absolute top-1 right-1 flex size-5 cursor-pointer items-center justify-center rounded-full bg-black/65 text-white opacity-85 transition-opacity hover:opacity-100"
    >
      <XIcon className="size-3" aria-hidden />
    </button>
  ) : null;
  const surface = cn('relative flex h-14 items-center rounded-[14px] bg-muted shadow-[inset_0_0_0_1px_rgba(123,123,123,0.12)]', className);
  const presence = {
    initial: { opacity: 0, scale: 0.9, filter: 'blur(4px)' },
    animate: { opacity: 1, scale: 1, filter: 'blur(0px)' },
    exit: { opacity: 0, scale: 0.9, filter: 'blur(4px)' },
    transition: { type: 'spring' as const, duration: 0.3, bounce: 0 },
  };

  if (file.kind === 'image') {
    return (
      <motion.div layout {...presence} className={cn(surface, 'w-14 overflow-hidden')} title={`${file.name} · ${file.detail ?? ''} · ${kb(file.size)}`}>
        <img src={file.dataUrl} alt={file.name} className="size-full object-cover" />
        {remove}
      </motion.div>
    );
  }
  const sub =
    file.kind === 'pdf'
      ? `PDF${file.pages ? ` · ${file.pages} page${file.pages > 1 ? 's' : ''}` : ''} · ${kb(file.size)}`
      : `${(file.name.split('.').pop() || 'text').toUpperCase()} · ${kb(file.size)}`;
  return (
    <motion.div layout {...presence} className={cn(surface, 'max-w-60 gap-2 pr-8 pl-2.5')} title={file.name}>
      <span className="bg-popover text-muted-foreground flex size-8.5 shrink-0 items-center justify-center rounded-[10px]">
        {file.kind === 'pdf' ? <FileTextIcon className="size-4" aria-hidden /> : <CodeIcon className="size-4" aria-hidden />}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[12.5px] font-medium">{file.name}</span>
        <span className="text-muted-foreground/70 text-[11.5px]">{sub}</span>
      </span>
      {remove}
    </motion.div>
  );
}
