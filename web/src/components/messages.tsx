import { motion } from 'framer-motion';
import { GlobeIcon, SparklesIcon } from 'lucide-react';
import * as React from 'react';
import type { Decision, Done } from '@/lib/api';
import type { Attachment } from '@/lib/attachments';
import { label, secs, shortModel, usd } from '@/lib/format';
import { renderMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { AttachmentTile } from './attachment-tile';
import { Chip } from './chip';

export interface Turn {
  id: string;
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

const Answer = React.memo(function Answer({ text }: { text: string }) {
  const html = React.useMemo(() => renderMarkdown(text), [text]);
  return <div className="prose-answer" dangerouslySetInnerHTML={{ __html: html }} />;
});

export function AssistantMessage({ turn, selected, onSelect }: { turn: Turn; selected: boolean; onSelect: () => void }) {
  const d = turn.decision;
  const c = d?.candidates?.[0];
  let body: React.ReactNode;
  if (turn.error) body = <ErrorBox>{turn.error}</ErrorBox>;
  else if (turn.dryRun && d) body = <span className="text-muted-foreground">Route only: no model was called.</span>;
  else if (turn.answer) {
    const sources = turn.done?.sources ?? [];
    body = (
      <>
        <Answer text={turn.answer} />
        {sources.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {sources.map((s, i) => (
              <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="hover:[&>span]:text-foreground">
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
  else body = <span className="shimmer-text">Asking Jev…</span>;

  return (
    <motion.div
      {...enter}
      onClick={onSelect}
      className={cn(
        '-mx-1.5 cursor-pointer rounded-2xl px-1.5 pt-1 pb-1.5 transition-colors duration-200 ease-[cubic-bezier(0.2,0,0,1)]',
        'hover:bg-muted/55',
        selected && 'bg-muted/55 shadow-[inset_0_0_0_1px_var(--border)]',
      )}
    >
      <div className="text-muted-foreground mt-1 mb-2 flex flex-wrap items-center gap-1.5 text-xs">
        {d ? (
          <>
            <Chip>
              <SparklesIcon aria-hidden />
              {shortModel(d.modelId)}
            </Chip>
            <Chip tone="soft">{d.effort}</Chip>
            <span>
              {label(d.task.taskType.value)} · d{d.task.difficulty.value}
            </span>
            {d.useWeb ? (
              <Chip tone="soft">
                <GlobeIcon aria-hidden />
                web
              </Chip>
            ) : null}
            {d.escalation ? <Chip tone="warn">escalated</Chip> : null}
            {d.task.source !== 'jev' ? <Chip tone="bad">keyword fallback</Chip> : null}
            <span className="ml-auto tabular-nums">
              {turn.done ? `${usd(turn.done.usage?.cost)} · ${secs(turn.done.latencyMs / 1000)}` : c ? `est ${usd(c.estCostUsd)} · ${secs(c.estLatencyS)}` : ''}
            </span>
          </>
        ) : (
          <span className="shimmer-text">Routing…</span>
        )}
      </div>
      <div className="px-0.5">{body}</div>
    </motion.div>
  );
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return <div className="text-bad rounded-xl border border-bad/25 bg-bad/8 px-3 py-2.5 text-[13px] whitespace-pre-wrap">{children}</div>;
}
