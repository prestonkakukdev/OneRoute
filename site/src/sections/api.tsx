import { motion } from 'framer-motion';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import { CheckIcon, CopyIcon } from 'lucide-react';
import * as React from 'react';
import { Reveal, SectionTitle } from '@/components/reveal';
import { API_EXAMPLES, API_POINTS } from '@/content';
import { cn } from '@/lib/utils';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);

const TABS = [
  { id: 'curl', label: 'cURL', lang: 'bash' },
  { id: 'typescript', label: 'TypeScript', lang: 'typescript' },
  { id: 'python', label: 'Python', lang: 'python' },
] as const;

export function Api() {
  const [tab, setTab] = React.useState<(typeof TABS)[number]['id']>('typescript');
  const [copied, setCopied] = React.useState(false);
  const active = TABS.find((t) => t.id === tab)!;
  const code = API_EXAMPLES[tab];
  const html = React.useMemo(() => hljs.highlight(code, { language: active.lang }).value, [code, active.lang]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <section id="api" className="mx-auto max-w-6xl px-6 pb-32">
      <SectionTitle>Set the model to auto.</SectionTitle>
      <Reveal className="bg-card overflow-hidden rounded-2xl border">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="flex gap-1" role="tablist" aria-label="Language">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'relative rounded-lg px-3 py-1.5 text-[13px] transition-colors duration-150',
                  tab === t.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab === t.id ? (
                  <motion.span layoutId="api-tab" className="absolute inset-0 rounded-lg bg-white/[0.06]" transition={{ type: 'spring', stiffness: 420, damping: 32 }} />
                ) : null}
                <span className="relative">{t.label}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={copy}
            aria-label={copied ? 'Copied' : 'Copy code'}
            className="text-muted-foreground hover:text-foreground flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-white/5"
          >
            {copied ? <CheckIcon className="size-4" aria-hidden /> : <CopyIcon className="size-4" aria-hidden />}
          </button>
        </div>
        <pre className="overflow-x-auto p-6 font-mono text-[13.5px] leading-relaxed">
          <code className="api-code" dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </Reveal>
      <div className="mt-4 grid grid-cols-3 gap-4 max-md:grid-cols-1">
        {API_POINTS.map((p, i) => (
          <Reveal key={p.title} delay={0.08 * (i + 1)} className="rounded-2xl border p-5">
            <h3 className="font-display text-[17px] font-medium">{p.title}</h3>
            <p className="text-muted-foreground mt-1.5 text-[14px] leading-relaxed">{p.body}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
