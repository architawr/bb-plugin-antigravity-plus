import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resolveAntigravityCommand, resolveAntigravityLaunchSpec } from '../cli.ts';
import { readAntigravityProviderUsage } from '../usage.ts';

test('Windows installer location works without agy on PATH for launch and usage', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-resolution-'));
  const env = { ...process.env, PATH: root, LOCALAPPDATA: root };
  const command = join(root, 'agy', 'bin', 'agy.exe');
  const previous = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA };
  try {
    process.env.PATH = root;
    process.env.LOCALAPPDATA = root;
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
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('launch resolves agy on the host even with workspace and session PATH decoys', t => {
  const root = mkdtempSync(join(tmpdir(), 'agy-host-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = ['host', 'workspace', 'session', 'spec'].map(name => join(root, name));
  const [host, cwd, sessionPath, specPath] = dirs;
  const name = process.platform === 'win32' ? 'agy.exe' : 'agy';
  for (const dir of dirs) {
    mkdirSync(dir);
    writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const previous = process.env.PATH;
  process.env.PATH = [host, previous].filter(Boolean).join(delimiter);
  t.after(() => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  });
  for (const envVars of [{ PATH: sessionPath }, {}]) {
    const spec = { command: 'agy', cwd, args: ['acp'], env: { PATH: specPath } };
    resolveAntigravityLaunchSpec({ params: { options: { providerOptions: { acpLaunchSpec: spec }, envVars } } });
    assert.equal(spec.command, join(host, name));
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

test('proxy launch spec sets ELECTRON_RUN_AS_NODE=1 for Electron hosts', () => {
  const spec = { command: 'agy', args: ['acp', '--disable-telemetry'], env: {} };
  resolveAntigravityLaunchSpec(
    { method: 'thread/start', params: { options: { providerOptions: { acpLaunchSpec: spec } } } },
    { hostFile: '/tmp/host.js', stateDir: '/tmp/state' },
  );
  assert.equal(spec.command, process.execPath);
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spec.env.BB_AGY_ACP_PROXY_STATE_DIR, '/tmp/state');
});

test('recovers proxy host artifact after BB prunes an older digest directory during plugin upgrade', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-artifact-gc-'));
  try {
    const oldDigest = 'a'.repeat(64);
    const midDigest = 'b'.repeat(64);
    const newDigest = 'c'.repeat(64);
    const deletedHostFile = join(root, oldDigest, 'host.mjs');

    // Simulate two surviving sibling artifacts and one unrelated non-digest directory.
    mkdirSync(join(root, midDigest), { recursive: true });
    mkdirSync(join(root, newDigest), { recursive: true });
    mkdirSync(join(root, 'not-a-digest'), { recursive: true });
    const midFile = join(root, midDigest, 'host.mjs');
    const newFile = join(root, newDigest, 'host.mjs');
    writeFileSync(midFile, '// older');
    writeFileSync(newFile, '// newest');
    writeFileSync(join(root, 'not-a-digest', 'host.mjs'), '// ignored');
    utimesSync(midFile, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    utimesSync(newFile, new Date(1_800_000_000_000), new Date(1_800_000_000_000));

    const spec = { command: 'agy', args: ['acp', '--disable-telemetry'], env: {} };
    resolveAntigravityLaunchSpec(
      { method: 'turn/start', params: { options: { providerOptions: { acpLaunchSpec: spec } } } },
      { hostFile: deletedHostFile, stateDir: '/tmp/state' },
    );
    assert.equal(spec.command, process.execPath);
    assert.equal(spec.args[0], newFile);
    assert.equal(spec.args[1], '--agy-acp-proxy');

    // If all digest artifacts are gone, degrade cleanly to launching agy directly instead of crashing with MODULE_NOT_FOUND.
    rmSync(join(root, midDigest), { recursive: true, force: true });
    rmSync(join(root, newDigest), { recursive: true, force: true });
    const fallbackSpec = { command: 'agy', args: ['acp', '--disable-telemetry'], env: {} };
    resolveAntigravityLaunchSpec(
      { method: 'turn/start', params: { options: { providerOptions: { acpLaunchSpec: fallbackSpec } } } },
      { hostFile: deletedHostFile, stateDir: '/tmp/state' },
    );
    assert.notEqual(fallbackSpec.command, process.execPath);
    assert.equal(fallbackSpec.args[0], 'acp');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
