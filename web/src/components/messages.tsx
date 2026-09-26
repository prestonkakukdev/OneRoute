import { AnimatePresence, motion } from 'framer-motion';
import { CheckIcon, CopyIcon, GlobeIcon, ScanSearchIcon } from 'lucide-react';
import * as React from 'react';
import type { Decision, Done } from '@/lib/api';
import type { Attachment } from '@/lib/attachments';
import { shortModel } from '@/lib/format';
import { renderMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { AttachmentTile } from './attachment-tile';
import { Chip } from './chip';

export interface Turn {
  id: string;
  /** What the user typed (may be empty when only files were sent). */
  text: string;
  /** Display label: the text, or the attached file names. */
  prompt: string;
  attachments: Attachment[];
  decision?: Decision;
  why: string[];
  answer: string;
  done?: Done;
  error?: string;
  thinking: boolean;
  dryRun: boolean;
  feedback?: string;
}

const enter = {
  initial: { opacity: 0, y: 6, filter: 'blur(4px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  transition: { duration: 0.3, ease: [0.2, 0, 0, 1] as const },
};

export function UserMessage({ turn }: { turn: Turn }) {
  return (
    <motion.div {...enter} className="flex flex-col items-end gap-1.5 self-end" style={{ maxWidth: '80%' }}>
      {turn.attachments.length ? (
        <div className="flex flex-wrap justify-end gap-2">
          {turn.attachments.map((f, i) => (
            <AttachmentTile key={i} file={f} className="bg-popover" />
          ))}
        </div>
      ) : null}
      {turn.prompt && !(turn.attachments.length && turn.prompt === turn.attachments.map((f) => f.name).join(', ')) ? (
        <div className="bg-muted rounded-[20px_20px_6px_20px] px-4 py-2.5 text-[15px] whitespace-pre-wrap break-words shadow-[inset_0_0_0_1px_rgba(123,123,123,0.12)]">
          {turn.prompt}
        </div>
      ) : null}
    </motion.div>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API refused (e.g. the window isn't focused): fall back to a hidden textarea + copy command.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.append(area);
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

const Answer = React.memo(function Answer({ text }: { text: string }) {
  const html = React.useMemo(() => renderMarkdown(text), [text]);
  // Code-block copy buttons come from the Markdown renderer; one delegated handler serves them all.
  const onClick = async (e: React.MouseEvent) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]');
    if (!button) return;
    e.stopPropagation();
    const code = button.closest('.code-block')?.querySelector('code')?.textContent ?? '';
    button.textContent = (await copyText(code)) ? 'Copied' : 'Copy failed';
    window.setTimeout(() => (button.textContent = 'Copy'), 1500);
  };
  return <div className="prose-answer" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});

// Quiet icon buttons under each answer (Copy, Inspect).
const ACTION_BTN =
  'text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 cursor-pointer items-center justify-center rounded-lg transition-colors duration-150 [&_svg]:size-4';

function CopyButton({ text }: { text: string }) {
  const [state, setState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  React.useEffect(() => {
    if (state === 'idle') return;
    const id = window.setTimeout(() => setState('idle'), 1500);
    return () => window.clearTimeout(id);
  }, [state]);
  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy response';
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      onClick={async () => setState((await copyText(text)) ? 'copied' : 'failed')}
      whileTap={{ scale: 0.92 }}
      className={cn(ACTION_BTN, state === 'failed' && 'text-bad')}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={state === 'copied' ? 'check' : 'copy'}
          initial={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
          transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
          className="flex"
        >
          {state === 'copied' ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}

export function AssistantMessage({ turn, inspecting, onInspect }: { turn: Turn; inspecting: boolean; onInspect: () => void }) {
  const d = turn.decision;
  let body: React.ReactNode;
  if (turn.error) body = <ErrorBox>{turn.error}</ErrorBox>;
  else if (turn.dryRun && d) body = <span className="text-muted-foreground">Route only: no model was called. Inspect it to see the decision.</span>;
  else if (turn.answer) {
    const sources = turn.done?.sources ?? [];
    body = (
      <>
        <Answer text={turn.answer} />
        {sources.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {sources.map((s, i) => (
              <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" className="hover:[&>span]:text-foreground">
                <Chip tone="soft">
                  <GlobeIcon aria-hidden />
                  {i + 1}. {s.title}
                </Chip>
              </a>
            ))}
          </div>
        ) : null}
      </>
    );
  } else if (d) body = <span className="shimmer-text">{turn.thinking ? 'Thinking…' : `Waiting for ${shortModel(d.modelId)}…`}</span>;
  else body = <span className="shimmer-text">{turn.dryRun ? 'Routing…' : 'Asking Jev…'}</span>;

  // Actions appear once the turn has settled (answered, failed, or routed only).
  const settled = Boolean(turn.done || turn.error || (turn.dryRun && d));
  return (
    <motion.div {...enter} className="px-0.5">
      {body}
      {settled ? (
        <div className="mt-2.5 flex items-center gap-0.5">
          {turn.answer ? <CopyButton text={turn.answer} /> : null}
          {d ? (
            <motion.button
              type="button"
              aria-label="Inspect this answer"
              aria-pressed={inspecting}
              title="Inspect: model, cost and why it was chosen"
              onClick={onInspect}
              whileTap={{ scale: 0.92 }}
              className={cn(ACTION_BTN, inspecting && 'bg-muted text-foreground')}
            >
              <ScanSearchIcon aria-hidden />
            </motion.button>
          ) : null}
        </div>
      ) : null}
    </motion.div>
  );
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return <div className="text-bad rounded-xl border border-bad/25 bg-bad/8 px-3 py-2.5 text-[13px] whitespace-pre-wrap">{children}</div>;
}
