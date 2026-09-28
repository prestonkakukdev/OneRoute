// What the agent may do without asking. Auto-edit (the default) runs reads, edits inside the worktree and ordinary
// commands freely; anything this classifier flags as dangerous waits for the user's approval. The classifier is a
// single function so a stricter agent-defense layer can replace or extend it later.

export type PermissionMode = 'auto' | 'ask' | 'plan';
export type ToolClass = 'read' | 'edit' | 'exec' | 'meta';

export interface Verdict {
  allowed: boolean; // may run without asking
  blocked?: string; // may not run at all (e.g. edits in plan mode)
  reason?: string; // why it needs approval
}

// Patterns for commands that can do damage outside the task, reach other machines, publish, or expose secrets.
const DANGEROUS: [RegExp, string][] = [
  [/\bgit\s+push\b/, 'pushes to a remote repository'],
  [/\bgit\s+(remote\s+(add|set-url|remove)|config\s+--global)\b/, 'changes git remotes or global git settings'],
  [/\bgit\s+(branch\s+-D|worktree\b|filter-branch|reflog\s+expire|update-ref\s+-d)/, 'rewrites or deletes git history or worktrees'],
  [/\bsudo\b|\bsu\s+-?\w*\b|\bdoas\b/, 'runs with elevated privileges'],
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+(\/|~|\$HOME|\.\.|\*|\.\s*$|\.\/?\s*$)/, 'recursively deletes outside or all of the workspace'],
  [/\brm\s+.*(^|\s)(\/[^\s]*|~[^\s]*|\$HOME[^\s]*|\.\.\/[^\s]*)/, 'deletes files outside the workspace'],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python\d?|node)\b/, 'pipes a download straight into a shell'],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bdocker\s+push\b/, 'publishes a package or image'],
  [/\bgh\s+(pr\s+(create|merge|close)|release|repo\s+(create|delete|edit)|secret|api\b)/, 'changes things on GitHub'],
  [/\b(ssh|scp|sftp|rsync)\b/, 'connects to another machine'],
  [/(~|\$HOME)\/\.(ssh|aws|gnupg|config\/gh|docker|kube|npmrc|netrc)|\bsecurity\s+find-/, 'touches credentials'],
  [/(^|[\s'"=/])\.env(?!\.example\b)(\.[\w.-]+)?\b/, 'reads or writes environment secrets'],
  [/\b(shutdown|reboot|halt|mkfs|diskutil\s+erase|launchctl|systemctl)\b|\bdd\s+if=/, 'affects the whole system'],
  [/\bchmod\s+-R\s+777\b|\bchown\s+-R\b/, 'changes permissions recursively'],
  [/(^|[^<])>\s*(\/(?!dev\/null|tmp\/)[^\s]*|~[^\s]*)/, 'writes to a file outside the workspace'],
  [/\bkill(all)?\s+-9\s+(-1|1)\b/, 'kills system processes'],
];

export function classifyCommand(command: string): string | null {
  for (const [pattern, reason] of DANGEROUS) if (pattern.test(command)) return reason;
  return null;
}

export function checkPermission(mode: PermissionMode, toolClass: ToolClass, command?: string): Verdict {
  if (toolClass === 'meta' || toolClass === 'read') return { allowed: true };
  if (mode === 'plan') return { allowed: false, blocked: 'Plan mode is read-only: propose the change instead of making it.' };
  if (toolClass === 'exec') {
    const danger = command ? classifyCommand(command) : null;
    if (danger) return { allowed: false, reason: `This command ${danger}.` };
    return mode === 'ask' ? { allowed: false, reason: 'Ask mode: every command needs approval.' } : { allowed: true };
  }
  // edit: always inside the worktree (paths are checked by the tool)
  return mode === 'ask' ? { allowed: false, reason: 'Ask mode: every edit needs approval.' } : { allowed: true };
}
