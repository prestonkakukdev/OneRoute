// The environment for commands the agent runs. It has no access to OneRoute's own keys, or any other secret in the
// server's environment, and is non-interactive.

import { homedir } from 'node:os';

export function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) continue;
    env[k] = v;
  }
  const home = homedir();
  env.PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin', `${home}/.bun/bin`, `${home}/.cargo/bin`, `${home}/.local/bin`].filter(Boolean).join(':');
  return { ...env, CI: '1', GIT_EDITOR: 'true', GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none' };
}
