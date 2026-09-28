// Sub-agents: the main agent hands a self-contained piece of work (explore the code, review the changes) to a
// helper that runs in its own fresh context, routed on its own, and returns only a structured report. The helper's
// file reads and command output never enter the main conversation, which stays small. Helpers cannot start helpers
// of their own (one level deep), which rules out runaway recursion and cost.

import { z } from 'zod';
import type { Mode } from '../taxonomy.js';

export type SubagentRole = 'explore' | 'review';

export const reportSchema = z.object({
  summary: z.string().describe('The answer or verdict in a few sentences'),
  findings: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string().optional(),
        file: z.string().optional(),
        line: z.number().int().optional(),
        severity: z.enum(['info', 'minor', 'major', 'critical']).optional(),
      }),
    )
    .max(30)
    .optional()
    .describe('Specific facts or problems, each with where it is'),
  files: z.array(z.string()).max(50).optional().describe('The files most relevant to the task'),
  passed: z.boolean().optional().describe('Reviews only: true if the work is correct and complete'),
});
export type Report = z.infer<typeof reportSchema>;

export interface RoleSpec {
  label: string;
  tools: string[]; // tool names the helper may use (always plus `report`)
  maxSteps: Record<Mode, number>;
  // Routed away from the main agent's model family (a second opinion from a different family catches more).
  differentFamily: boolean;
  instructions: string;
}

// Helpers are billed per step and each step re-sends the whole context, so fewer, fuller steps are cheaper.
const EFFICIENT = 'Work in few steps: read several files or run several checks in one step (multiple tool calls at once, one check_page with many steps), and report as soon as you have enough.';

export const ROLES: Record<SubagentRole, RoleSpec> = {
  explore: {
    label: 'Explorer',
    tools: ['list_files', 'grep', 'read_file', 'bash', 'process_output', 'wait'],
    maxSteps: { cheap: 8, balanced: 20, best: 30 },
    differentFamily: false,
    instructions: [
      'You are an explorer helping a coding agent. Investigate the question below in the project and report what you found.',
      'Read, search and run read-only commands as needed (tests, builds, git log/diff are fine). Do not change any files.',
      'Be specific: name files, functions and line numbers. Put the answer in summary and the supporting facts in findings.',
      EFFICIENT,
    ].join('\n'),
  },
  review: {
    label: 'Reviewer',
    tools: ['list_files', 'grep', 'read_file', 'bash', 'check_page', 'process_output', 'wait'],
    maxSteps: { cheap: 8, balanced: 20, best: 30 },
    differentFamily: true,
    instructions: [
      'You are a reviewer checking another coding agent’s work. Find real problems before the user does.',
      'Read the changed code and what it touches, run the tests or the page if useful, and look for bugs, missed requirements, broken edge cases and regressions. Do not change any files.',
      'Report only problems you verified, each with file, line and severity; say passed: true only if the work is correct and complete.',
      EFFICIENT,
    ].join('\n'),
  },
};

// The main agent's tool for starting a helper.
export const subagentInput = z.object({
  role: z.enum(['explore', 'review']).describe('explore: investigate code or logs and report; review: check the work done so far'),
  task: z.string().min(1).describe('Self-contained instructions: the helper sees nothing of this conversation'),
});

export function formatReport(role: SubagentRole, r: Report): string {
  return JSON.stringify({ role, ...r });
}
