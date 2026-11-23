import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../server.ts';
import { experimental_acpLaunchSpecSchema } from '@get-bb/plugin-sdk/provider-bridge/acp';

test('registers a native ACP provider without changing credentials or bypassing approvals', async () => {
  const declarations = [];
  await plugin({
    settings: {
      define(descriptors) {
        assert.equal(descriptors.autoApprove.default, false);
        assert.equal(descriptors.promptOnSandboxEscape.default, true);
        assert.equal(descriptors.sandbox.default, false);
        assert.equal(descriptors.processPerSession.default, true);
        assert.equal(descriptors.subagentsDisabled.default, false);
        assert.equal(descriptors.commandDescriptionsEnabled.default, true);
        assert.equal(descriptors.acpProxy, undefined);
        assert.equal(descriptors.enabled.default, true);
        return { get: async () => ({ enabled: true }), onChange() {} };
      },
    },
    providers: { register(value) { declarations.push(value); return { dispose() {} }; } },
  });
  assert.equal(declarations.length, 1);
  const provider = declarations[0];
  assert.equal(provider.id, 'antigravity-plus');
  assert.equal(provider.icon, './assets/provider.svg');
  assert.deepEqual(provider.composerActions, []);
  const spec = experimental_acpLaunchSpecSchema.parse(provider.experimental_bridgeOptions.acpLaunchSpec);
  assert.equal(spec.command, 'agy');
  assert.deepEqual(spec.args, ['acp', '--disable-telemetry']);
  assert.deepEqual(spec.env, {});
  assert.equal(spec.cwd, undefined);
  assert.equal(spec.permissionCli, undefined);
  assert.deepEqual(provider.capabilities.permissionModes, ['accept-edits', 'full']);
  assert.deepEqual(provider.capabilities.reasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(provider.maintenance, { health: true, usage: true, installation: true });
  assert.equal(provider.experimental_bridgeOptions.acpDialect, 'antigravity-plus');
});


test('sandbox and processPerSession only change fixed CLI arguments', async () => {
  let provider;
  await plugin({
    settings: { define() { return { get: async () => ({ enabled: true }), onChange() {} }; } },
    providers: { register(value) { provider = value; return { dispose() {} }; } },
  });
  for (const sandbox of [undefined, false, true, 'true']) {
    for (const processPerSession of [undefined, true, false]) {
      const options = provider.deriveProviderOptions({ settings: { sandbox, processPerSession } });
      const spec = experimental_acpLaunchSpecSchema.parse(options.acpLaunchSpec);
      assert.deepEqual(spec.args, [
        'acp',
        '--disable-telemetry',
        ...(processPerSession !== false ? ['--process-per-session'] : []),
        ...(sandbox === true ? ['--sandbox'] : []),
      ]);
      assert.equal(spec.command, 'agy');
      assert.deepEqual(spec.env, {});
      assert.equal(options.acpDialect, 'antigravity-plus');
    }
  }
  for (const autoApprove of [undefined, false, true, 'true']) {
    assert.equal(provider.deriveProviderOptions({ settings: { autoApprove } }).autoApprove, autoApprove === true);
  }
  for (const promptOnSandboxEscape of [undefined, false, true]) {
    assert.equal(
      provider.deriveProviderOptions({ settings: { promptOnSandboxEscape } }).promptOnSandboxEscape,
      promptOnSandboxEscape !== false
    );
  }
  for (const subagentsDisabled of [undefined, false, true, 'true']) {
    assert.equal(
      provider.deriveProviderOptions({ settings: { subagentsDisabled } }).providerSubagentsEnabled,
      subagentsDisabled !== true
    );
  }
  for (const commandDescriptionsEnabled of [undefined, false, true, 'false']) {
    assert.equal(
      provider.deriveProviderOptions({ settings: { commandDescriptionsEnabled } }).commandDescriptionsEnabled,
      commandDescriptionsEnabled !== false
    );
  }
  assert.ok(provider.experimental_nativeSkillRoots.user.includes('.gemini/antigravity-cli/skills'));
  assert.ok(provider.experimental_nativeSkillRoots.user.some(
    root => typeof root === 'object' && root.path === '.gemini/antigravity-cli/builtin/skills' && root.namePrefix === 'antigravity:'
  ));
  assert.ok(provider.experimental_nativeSkillRoots.project.some(
    root => typeof root === 'object' && root.path === '.agents/skills' && root.ancestors === true
  ));
  assert.equal(provider.capabilities.fork, 'tip');
  assert.equal(provider.capabilities.supportsManualCompaction, true);
});
