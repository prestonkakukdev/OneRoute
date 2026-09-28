import { motion } from 'framer-motion';
import { BookOpenIcon, BugIcon, FlaskConicalIcon, FolderGitIcon, FolderPlusIcon, GitBranchIcon, SparklesIcon } from 'lucide-react';
import type * as React from 'react';
import type { CodeProject } from './api';

const STARTERS: { icon: React.ReactNode; title: string; prompt: string }[] = [
  { icon: <BookOpenIcon />, title: 'Explain this project', prompt: 'Explain how this project is structured, what the main pieces do, and how to run it.' },
  { icon: <BugIcon />, title: 'Find and fix a bug', prompt: 'Look for a bug in this project, fix the most important one you find, and verify the fix.' },
  { icon: <FlaskConicalIcon />, title: 'Add tests', prompt: 'Add tests for the most important logic that isn’t covered yet, and make sure they pass.' },
  { icon: <SparklesIcon />, title: 'Build something new', prompt: 'Build ' },
];

const rise = (delay: number) => ({
  initial: { opacity: 0, y: 10, filter: 'blur(6px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  transition: { duration: 0.6, delay, ease: [0.2, 0, 0, 1] as const },
});

// What a new Code session starts on: the project it works in and a few ways to begin.
export function CodeHome({ project, isolated, onOpenFolder, onStarter }: { project?: CodeProject; isolated: boolean; onOpenFolder: () => void; onStarter: (prompt: string) => void }) {
  return (
    // Centred in the space above the composer; on short windows the less important parts drop out instead of scrolling.
    <div className="mx-auto flex h-full max-w-160 flex-col items-center justify-center pb-[4vh] text-center">
      <motion.h2 {...rise(0.1)} className="font-display text-[34px] leading-[1.12] font-medium tracking-[-0.02em] text-balance max-sm:text-[27px]">
        {project ? `What should we build in ${project.name}?` : 'Build with the right model for every step.'}
      </motion.h2>
      <motion.p {...rise(0.18)} className="text-muted-foreground mt-4 max-w-120 [@media(max-height:560px)]:hidden text-[14.5px] leading-relaxed text-balance">
        {project
          ? 'OneRoute routes each run to the model and effort that fit it, checks the work with your tests and a real browser, and keeps a checkpoint for every message.'
          : 'Open a folder on this computer. The agent reads, edits, runs and tests the project there, and only there.'}
      </motion.p>

      {project ? (
        <>
          <motion.div {...rise(0.26)} className="text-muted-foreground mt-6 flex items-center [@media(max-height:640px)]:hidden gap-2 rounded-lg border bg-white/[0.015] px-3 py-1.5 text-[12.5px]" title={project.path}>
            {isolated ? <GitBranchIcon className="size-3.5" aria-hidden /> : <FolderGitIcon className="size-3.5" aria-hidden />}
            <span className="text-foreground/90 font-medium">{project.name}</span>
            <span className="max-w-72 truncate font-mono text-[11.5px] opacity-70">{project.path}</span>
            <span className="opacity-60">· {isolated ? 'separate branch' : 'edits in place'}</span>
          </motion.div>
          <motion.div {...rise(0.34)} className="mt-6 grid w-full grid-cols-2 gap-2 max-sm:grid-cols-1 [@media(max-height:500px)]:hidden">
            {STARTERS.map((s) => (
              <button
                key={s.title}
                type="button"
                onClick={() => onStarter(s.prompt)}
                className="group hover:bg-muted/50 flex cursor-pointer items-start gap-3 rounded-lg border bg-white/[0.015] px-3.5 py-3 text-left transition-colors active:scale-[0.99]"
              >
                <span className="text-muted-foreground group-hover:text-arc mt-0.5 flex shrink-0 transition-colors [&_svg]:size-4">{s.icon}</span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium">{s.title}</span>
                  <span className="text-muted-foreground mt-0.5 line-clamp-2 block text-[12.5px] leading-snug [@media(max-height:760px)]:hidden">{s.prompt === 'Build ' ? 'Describe a feature, page or app and it gets built and checked.' : s.prompt}</span>
                </span>
              </button>
            ))}
          </motion.div>
        </>
      ) : (
        <motion.button
          {...rise(0.26)}
          type="button"
          onClick={onOpenFolder}
          className="mt-7 inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-linear-to-b from-[#f7f7f7] to-white px-4 text-[13.5px] font-medium text-black active:scale-[0.97]"
        >
          <FolderPlusIcon className="size-4" aria-hidden />
          Open a folder
        </motion.button>
      )}
    </div>
  );
}
