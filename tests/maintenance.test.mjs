import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MINIMUM_SUPPORTED_AGY_VERSION,
  planAntigravityInstallationRun,
  readAntigravityHealth,
  readAntigravityInstallationStatus,
} from '../maintenance.ts';

test('reports not_installed health and platform-appropriate install command when agy is missing', async () => {
  const status = await readAntigravityInstallationStatus({
    platform: 'darwin',
    resolveCommand: () => null,
  });
  assert.equal(status.installed, false);
  assert.equal(status.installSource, 'notInstalled');
  assert.equal(status.minimumSupportedVersion, MINIMUM_SUPPORTED_AGY_VERSION);
  assert.equal(status.installAction?.kind, 'install');
  assert.match(status.installAction?.command ?? '', /antigravity\.google\/cli\/install\.sh/);

  const health = await readAntigravityHealth({ platform: 'darwin', resolveCommand: () => null });
  assert.equal(health.supported, true);
  assert.equal(health.health.status, 'not_installed');
  assert.equal(health.health.canInstall, true);
  assert.equal(health.health.canUpdate, false);

  const installRun = await planAntigravityInstallationRun('install', { platform: 'win32', resolveCommand: () => null });
  assert.equal(installRun.available, true);
  if (installRun.available) {
    assert.equal(installRun.command.command, 'powershell.exe');
    assert.match(installRun.command.displayCommand, /antigravity\.google\/cli\/install\.ps1/);
    assert.deepEqual(installRun.verification, { kind: 'installed' });
  }

  const updateRun = await planAntigravityInstallationRun('update', { platform: 'darwin', resolveCommand: () => null });
  assert.equal(updateRun.available, false);
});

test('flags agy older than 1.5.0 as unsupported_version and proposes agy update', async () => {
  const opts = {
    resolveCommand: () => '/usr/local/bin/agy',
    execFile: async () => ({ stdout: '1.4.9\n', stderr: '' }),
  };
  const status = await readAntigravityInstallationStatus(opts);
  assert.equal(status.installed, true);
  assert.equal(status.currentVersion, '1.4.9');
  assert.equal(status.versionUnsupported, true);
  assert.equal(status.needsUpdate, true);
  assert.deepEqual(status.installAction, { kind: 'update', label: 'Update', command: 'agy update' });

  const health = await readAntigravityHealth(opts);
  assert.equal(health.health.status, 'unsupported_version');
  assert.equal(health.health.installedVersion, '1.4.9');
  assert.equal(health.health.canUpdate, true);
  assert.match(health.health.statusMessage ?? '', /agy update/);

  const run = await planAntigravityInstallationRun('update', opts);
  assert.equal(run.available, true);
  if (run.available) {
    assert.deepEqual(run.command, { command: '/usr/local/bin/agy', args: ['update'], displayCommand: 'agy update' });
    assert.deepEqual(run.verification, { kind: 'version_changed', previousVersion: '1.4.9' });
  }
});

test('reports ready, unauthenticated, and expired health states for agy 1.5.15', async () => {
  const base = {
    resolveCommand: () => '/Users/test/.local/bin/agy',
    execFile: async () => ({ stdout: '1.5.15\n', stderr: '' }),
  };
  const status = await readAntigravityInstallationStatus(base);
  assert.equal(status.installed, true);
  assert.equal(status.currentVersion, '1.5.15');
  assert.equal(status.versionUnsupported, false);
  assert.equal(status.needsUpdate, false);

  const ready = await readAntigravityHealth({
    ...base,
    checkUsage: async () => ({ supported: true, usage: { status: 'ok', accountEmail: null, planLabel: null, windows: [] } }),
  });
  assert.equal(ready.health.status, 'ready');
  assert.equal(ready.health.installedVersion, '1.5.15');
  assert.equal(ready.health.loginCommand, 'agy acp --login');
  assert.equal(ready.health.localLoginCommand, 'agy acp --login');

  const unauth = await readAntigravityHealth({
    ...base,
    checkUsage: async () => ({ supported: true, usage: { status: 'unauthenticated' } }),
  });
  assert.equal(unauth.health.status, 'unauthenticated');
  assert.match(unauth.health.statusMessage ?? '', /agy acp --login/);
  assert.equal(unauth.health.localLoginCommand, 'agy acp --login');

  const expired = await readAntigravityHealth({
    ...base,
    checkUsage: async () => ({ supported: true, usage: { status: 'expired' } }),
  });
  assert.equal(expired.health.status, 'expired');
  assert.match(expired.health.statusMessage ?? '', /expired/i);
});
