import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { plistFor, SERVICE_LABEL } from '../src/cli/service.js';

describe('background service', () => {
  it('writes a launchd agent that starts at login, stays alive and runs the supervisor from the repo', () => {
    const xml = plistFor({ node: '/opt/homebrew/bin/node', port: 8787 });
    expect(xml).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(xml).toMatch(/<key>RunAtLoad<\/key><true\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key><true\/>/);
    expect(xml).toContain('scripts/service.mjs');
    expect(xml).toContain('<key>ROUTER_PORT</key><string>8787</string>');
    // The repo path contains a space and '&' would break XML: both must survive.
    expect(plistFor({ node: '/a & b/node', port: 1 })).toContain('/a &amp; b/node');
    if (process.platform === 'darwin') {
      const file = join(mkdtempSync(join(tmpdir(), 'plist-')), 'agent.plist');
      writeFileSync(file, xml);
      expect(spawnSync('plutil', ['-lint', file], { encoding: 'utf8' }).stdout).toContain('OK');
    }
  });
});
