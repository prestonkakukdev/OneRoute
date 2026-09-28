// Project folders and git worktrees. A session either edits the user's folder directly (see checkpoints.ts for its
// diff and undo) or works in its own worktree on its own branch, leaving the user's checkout untouched.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const WORKTREES_DIR = join(homedir(), '.oneroute', 'worktrees');

export async function git(cwd: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout;
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(path, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

export async function repoRoot(path: string): Promise<string> {
  return (await git(path, ['rev-parse', '--show-toplevel'])).trim();
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'task';

export interface Workspace {
  worktree: string;
  branch: string;
  baseRef: string; // the user's branch when the session started
  baseCommit: string;
}

// A fresh worktree from the project's current commit, on a new `oneroute/...` branch.
export async function createWorkspace(projectPath: string, sessionId: string, title: string): Promise<Workspace> {
  const short = sessionId.replace(/-/g, '').slice(0, 6);
  const baseRef = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const baseCommit = (await git(projectPath, ['rev-parse', 'HEAD'])).trim();
  const branch = `oneroute/${slug(title)}-${short}`;
  mkdirSync(WORKTREES_DIR, { recursive: true });
  const worktree = join(WORKTREES_DIR, `${slug(basename(projectPath))}-${short}`);
  await git(projectPath, ['worktree', 'add', '-b', branch, worktree, baseCommit]);
  return { worktree, branch, baseRef, baseCommit };
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

// Everything the session changed since it started: commits on its branch plus uncommitted work, including
// new files.
export async function workspaceDiff(ws: Pick<Workspace, 'worktree' | 'baseCommit'>): Promise<{ files: DiffFile[]; patch: string }> {
  if (!existsSync(ws.worktree)) return { files: [], patch: '' };
  await git(ws.worktree, ['add', '-A']);
  const numstat = await git(ws.worktree, ['diff', '--cached', '--numstat', '-M', ws.baseCommit]);
  const nameStatus = await git(ws.worktree, ['diff', '--cached', '--name-status', '-M', ws.baseCommit]);
  const statusOf = new Map<string, DiffFile['status']>();
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const [code, ...paths] = line.split('\t');
    const path = paths.at(-1)!;
    statusOf.set(path, code!.startsWith('A') ? 'added' : code!.startsWith('D') ? 'deleted' : code!.startsWith('R') ? 'renamed' : 'modified');
  }
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [a, r, ...rest] = line.split('\t');
      const raw = rest.join('\t');
      const path = raw.includes(' => ') ? raw.replace(/.*=> /, '').replace(/[{}]/g, '') : raw;
      return { path, added: Number(a) || 0, removed: Number(r) || 0, status: statusOf.get(path) ?? 'modified' };
    });
  const patch = await git(ws.worktree, ['diff', '--cached', '-M', ws.baseCommit]);
  return { files, patch };
}

// Commits the session's work on its own branch (the user merges it when they're happy).
export async function saveToBranch(ws: Pick<Workspace, 'worktree'>, message: string): Promise<string | null> {
  await git(ws.worktree, ['add', '-A']);
  const staged = (await git(ws.worktree, ['diff', '--cached', '--name-only'])).trim();
  if (!staged) return null;
  await git(ws.worktree, ['commit', '-m', message, '--no-verify']);
  return (await git(ws.worktree, ['rev-parse', '--short', 'HEAD'])).trim();
}

export async function discardWorkspace(projectPath: string, ws: Pick<Workspace, 'worktree' | 'branch'>): Promise<void> {
  if (existsSync(ws.worktree)) await git(projectPath, ['worktree', 'remove', '--force', ws.worktree]);
  await git(projectPath, ['worktree', 'prune']);
  try {
    await git(projectPath, ['branch', '-D', ws.branch]);
  } catch {}
}

// Folders a project may be opened in: anything the user picks, except the whole disk or home folder.
export function checkProjectFolder(path: string): string | null {
  const full = resolve(path);
  if (full === '/' || full === homedir() || full === resolve(homedir(), '..')) return 'Pick a project folder, not your whole disk or home folder.';
  return null;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  home: string;
  entries: { name: string; path: string; git: boolean }[];
}

// Lists the subfolders of a folder for the app's folder picker (hidden folders and dependencies left out).
export function listFolders(path: string = homedir()): FolderListing {
  const full = resolve(path);
  const entries = readdirSync(full, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== 'Library')
    .map((d) => ({ name: d.name, path: join(full, d.name), git: existsSync(join(full, d.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(full);
  return { path: full, parent: parent === full ? null : parent, home: homedir(), entries };
}

// Files in the project: git's view (respects .gitignore) in a repository, otherwise a bounded walk.
export async function listProjectFiles(folder: string): Promise<string[]> {
  if (await isGitRepo(folder)) return (await git(folder, ['ls-files', '--cached', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', 'target']);
  const walk = (dir: string, prefix: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= 2000) return;
      if (d.name.startsWith('.') && d.name !== '.env.example') continue;
      if (d.isDirectory()) {
        if (!skip.has(d.name)) walk(join(dir, d.name), `${prefix}${d.name}/`);
      } else out.push(`${prefix}${d.name}`);
    }
  };
  walk(folder, '');
  return out;
}


// The native macOS folder chooser (Finder's "Choose Folder" window, with New Folder), opened by the local server on
// the user's Mac. Resolves to the chosen path, or null if they cancel. Other systems use the app's own picker.
export function chooseFolderNative(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('The system folder chooser is only available on macOS.'));
  const script = [
    'activate', // bring the chooser in front of the browser
    'set chosen to choose folder with prompt "Choose a folder for OneRoute to work in" default location (path to home folder)',
    'POSIX path of chosen',
  ];
  return new Promise((resolvePick, reject) => {
    execFile('osascript', script.flatMap((line) => ['-e', line]), { timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) {
        // -128 = the user pressed Cancel
        if (/-128|User canceled/i.test(`${stderr} ${err.message}`)) resolvePick(null);
        else reject(new Error(`Could not open the folder chooser: ${stderr.trim() || err.message}`));
        return;
      }
      const path = stdout.trim().replace(/\/$/, '');
      resolvePick(path || null);
    });
  });
}
