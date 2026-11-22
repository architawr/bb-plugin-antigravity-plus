import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAntigravityCommand, resolveAntigravityLaunchSpec } from '../cli.ts';
import { readAntigravityProviderUsage } from '../usage.ts';

test('Windows installer location works without agy on PATH for launch and usage', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-resolution-'));
  const env = { ...process.env, PATH: root, LOCALAPPDATA: root };
  const command = join(root, 'agy', 'bin', 'agy.exe');
  try {
    assert.equal(resolveAntigravityCommand('agy', { env }), null);
    mkdirSync(join(root, 'agy', 'bin'), { recursive: true });
    writeFileSync(command, 'fixture');
    assert.equal(resolveAntigravityCommand('agy', { env }), command);
    for (const nested of [false, true]) {
      const spec = { command: 'agy', args: ['acp'], env };
      const providerOptions = { acpLaunchSpec: spec };
      const request = { params: nested ? { options: { providerOptions } } : { providerOptions } };
      resolveAntigravityLaunchSpec(request);
      assert.equal(spec.command, command);
      assert.deepEqual(spec.args, ['acp']);
    }
    assert.equal(resolveAntigravityCommand('missing-custom-cli', { env }), null);
    let executed;
    await readAntigravityProviderUsage({ env, execFile: async executable => {
      executed = executable;
      return { stdout: '{}', stderr: '' };
    } });
    assert.equal(executed, command);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit executable paths are preserved', () => {
  const request = { params: { providerOptions: { acpLaunchSpec: { command: process.execPath } } } };
  resolveAntigravityLaunchSpec(request);
  assert.equal(request.params.providerOptions.acpLaunchSpec.command, process.execPath);
});

test('profile directory env vars append --gemini-dir and --app-data-dir to acp launch args', () => {
  for (const nested of [false, true]) {
    const spec = { command: process.execPath, args: ['acp', '--disable-telemetry'], env: {} };
    const envVars = {
      BB_ANTIGRAVITY_GEMINI_DIR: '/var/lib/bb/agy-profiles/acct-1/.gemini',
      BB_ANTIGRAVITY_APP_DATA_DIR: 'antigravity-cli',
    };
    const request = {
      params: nested
        ? { options: { providerOptions: { acpLaunchSpec: spec }, envVars } }
        : { providerOptions: { acpLaunchSpec: spec }, envVars },
    };
    resolveAntigravityLaunchSpec(request);
    assert.deepEqual(spec.args, [
      'acp',
      '--disable-telemetry',
      '--gemini-dir',
      '/var/lib/bb/agy-profiles/acct-1/.gemini',
      '--app-data-dir',
      'antigravity-cli',
    ]);
  }
});

test('empty env overrides neutralize inherited profile directory env vars without duplicating explicit flags', () => {
  const original = process.env.BB_ANTIGRAVITY_GEMINI_DIR;
  process.env.BB_ANTIGRAVITY_GEMINI_DIR = '/inherited/.gemini';
  try {
    const neutralized = { command: process.execPath, args: ['acp'], env: {} };
    resolveAntigravityLaunchSpec({
      params: {
        options: {
          providerOptions: { acpLaunchSpec: neutralized },
          envVars: { BB_ANTIGRAVITY_GEMINI_DIR: '' },
        },
      },
    });
    assert.deepEqual(neutralized.args, ['acp']);

    const explicit = { command: process.execPath, args: ['acp', '--gemini-dir', '/explicit/.gemini'], env: {} };
    resolveAntigravityLaunchSpec({
      params: {
        providerOptions: { acpLaunchSpec: explicit },
        envVars: { BB_ANTIGRAVITY_GEMINI_DIR: '/override/.gemini' },
      },
    });
    assert.deepEqual(explicit.args, ['acp', '--gemini-dir', '/explicit/.gemini']);
  } finally {
    if (original === undefined) delete process.env.BB_ANTIGRAVITY_GEMINI_DIR;
    else process.env.BB_ANTIGRAVITY_GEMINI_DIR = original;
  }
});
