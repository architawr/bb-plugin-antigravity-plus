import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import {
  AGY_ACP_PROXY_FLAG,
  AGY_ACP_PROXY_STATE_DIR_ENV,
  AgyAcpProxy,
  createInstructionStore,
  describeOutdatedAgy,
  extractSystemInstructions,
  isAgyVersionTooOld,
  parseAgyVersion,
  withSystemPrompt,
} from '../acp-proxy.ts';
import { resolveAntigravityLaunchSpec } from '../cli.ts';

const BLOCK = '<system_instructions>\nUse bb rules.\n</system_instructions>';
const line = message => JSON.stringify({ jsonrpc: '2.0', ...message });

function harness(store = createInstructionStore(undefined)) {
  const toAgent = [];
  const toClient = [];
  const logs = [];
  const proxy = new AgyAcpProxy({ toAgent: l => toAgent.push(JSON.parse(l)), toClient: l => toClient.push(JSON.parse(l)), store, log: m => logs.push(m) });
  return { proxy, toAgent, toClient, logs, store };
}

function openSession(h, mcpServers = [{ name: 'bb-bridge', command: 'node', args: [], env: [] }]) {
  h.proxy.fromClient(line({ id: 1, method: 'session/new', params: { cwd: '/work', mcpServers } }));
  h.proxy.fromAgent(line({ id: 1, result: { sessionId: 's1' } }));
  h.toAgent.length = 0;
  h.toClient.length = 0;
}

test('extracts only a well-formed bridge instructions block', () => {
  assert.equal(extractSystemInstructions(BLOCK), 'Use bb rules.');
  assert.equal(extractSystemInstructions(`${BLOCK}\n`), 'Use bb rules.');
  assert.equal(extractSystemInstructions('<system_instructions>\nunterminated'), undefined);
  assert.equal(extractSystemInstructions('hello <system_instructions>x</system_instructions>'), undefined);
  assert.equal(extractSystemInstructions('<system_instructions>\n  \n</system_instructions>'), undefined);
  assert.equal(extractSystemInstructions(42), undefined);
});

test('adds a system prompt to _meta without replacing one the client set', () => {
  assert.deepEqual(withSystemPrompt(undefined, 'a'), { antigravity: { systemPrompt: { append: 'a' } } });
  assert.deepEqual(withSystemPrompt({ other: 1, antigravity: { tier: true } }, 'a'), { other: 1, antigravity: { tier: true, systemPrompt: { append: 'a' } } });
  const own = { antigravity: { systemPrompt: { append: 'mine' } } };
  assert.equal(withSystemPrompt(own, 'a'), own);
});

test('passes unrelated traffic through unchanged, including non-JSON lines', () => {
  const sent = [];
  const proxy = new AgyAcpProxy({ toAgent: l => sent.push(l), toClient: l => sent.push(l), store: createInstructionStore(undefined) });
  const raw = '{"jsonrpc":"2.0","id":7,"method":"session/set_mode","params":{"sessionId":"s1","modeId":"plan"}}';
  proxy.fromClient(raw);
  proxy.fromClient('not json');
  proxy.fromAgent('{"jsonrpc":"2.0","method":"session/update","params":{}}');
  assert.deepEqual(sent, [raw, 'not json', '{"jsonrpc":"2.0","method":"session/update","params":{}}']);
});

test('moves the first-prompt instructions block into a live session/resume system prompt', () => {
  const h = harness();
  openSession(h);
  h.proxy.fromClient(line({ id: 2, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: BLOCK }, { type: 'text', text: '/plan do it' }] } }));
  assert.equal(h.toAgent.length, 1);
  const resume = h.toAgent[0];
  assert.equal(resume.method, 'session/resume');
  assert.match(resume.id, /^bb-agy-acp-proxy:/);
  assert.deepEqual(resume.params, {
    sessionId: 's1',
    cwd: '/work',
    mcpServers: [{ name: 'bb-bridge', command: 'node', args: [], env: [] }],
    _meta: { antigravity: { systemPrompt: { append: 'Use bb rules.' } } },
  });
  h.proxy.fromClient(line({ method: 'session/cancel', params: { sessionId: 's1' } }));
  assert.equal(h.toAgent.length, 1, 'later client messages wait for the resume');
  h.proxy.fromAgent(line({ id: resume.id, result: { configOptions: [] } }));
  assert.deepEqual(h.toClient, [], 'the proxy-originated response stays in the proxy');
  assert.deepEqual(h.toAgent.slice(1), [
    { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: '/plan do it' }] } },
    { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } },
  ]);
  assert.equal(h.store.get('s1'), 'Use bb rules.');
});

test('falls back to the original prompt when agy rejects the resume', () => {
  const h = harness();
  openSession(h);
  const prompt = { id: 2, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: BLOCK }, { type: 'text', text: 'hi' }] } };
  h.proxy.fromClient(line(prompt));
  h.proxy.fromAgent(line({ id: h.toAgent[0].id, error: { code: -32601, message: 'no' } }));
  assert.deepEqual(h.toAgent[1], { jsonrpc: '2.0', ...prompt });
  assert.equal(h.logs.length, 1);
});

test('leaves prompts alone when there is no block, no other input, or no known session', () => {
  const h = harness();
  openSession(h);
  const prompts = [
    { id: 2, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] } },
    { id: 3, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: BLOCK }] } },
    { id: 4, method: 'session/prompt', params: { sessionId: 'unknown', prompt: [{ type: 'text', text: BLOCK }, { type: 'text', text: 'hi' }] } },
  ];
  for (const p of prompts) h.proxy.fromClient(line(p));
  assert.deepEqual(h.toAgent, prompts.map(p => ({ jsonrpc: '2.0', ...p })));
});

test('re-applies stored instructions when the bridge loads or resumes the session', () => {
  const h = harness();
  h.store.set('s1', 'Use bb rules.');
  h.proxy.fromClient(line({ id: 5, method: 'session/load', params: { sessionId: 's1', cwd: '/work', mcpServers: [] } }));
  h.proxy.fromClient(line({ id: 6, method: 'session/resume', params: { sessionId: 's1', cwd: '/work', mcpServers: [], _meta: { antigravity: { systemPrompt: { append: 'mine' } } } } }));
  h.proxy.fromClient(line({ id: 7, method: 'session/load', params: { sessionId: 'other', cwd: '/work', mcpServers: [] } }));
  assert.deepEqual(h.toAgent[0].params._meta, { antigravity: { systemPrompt: { append: 'Use bb rules.' } } });
  assert.deepEqual(h.toAgent[1].params._meta, { antigravity: { systemPrompt: { append: 'mine' } } });
  assert.equal(h.toAgent[2].params._meta, undefined);
});

test('persists instructions per session and refuses unsafe session ids as file names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-proxy-store-'));
  try {
    createInstructionStore(dir).set('abc-123', 'rules');
    createInstructionStore(dir).set('../escape', 'nope');
    assert.equal(createInstructionStore(dir).get('abc-123'), 'rules');
    assert.equal(createInstructionStore(dir).get('../escape'), undefined);
    assert.deepEqual(readdirSync(dir), ['abc-123.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session launches go through the proxy; provider requests and opted-out threads do not', () => {
  const proxy = { hostFile: '/plugin/host.mjs', stateDir: '/data/acp-proxy/instructions' };
  const spec = () => ({ displayName: 'Antigravity CLI', command: 'agy', args: ['acp', '--disable-telemetry'], env: {} });
  const start = { method: 'thread/start', params: { options: { providerOptions: { acpLaunchSpec: spec() } } } };
  resolveAntigravityLaunchSpec(start, proxy);
  const launched = start.params.options.providerOptions.acpLaunchSpec;
  assert.equal(launched.command, process.execPath);
  assert.deepEqual(launched.args.slice(0, 2), ['/plugin/host.mjs', AGY_ACP_PROXY_FLAG]);
  assert.match(launched.args[2], /agy(\.exe)?$/);
  assert.deepEqual(launched.args.slice(3), ['acp', '--disable-telemetry']);
  assert.equal(launched.env[AGY_ACP_PROXY_STATE_DIR_ENV], proxy.stateDir);
  resolveAntigravityLaunchSpec(start, proxy);
  assert.equal(launched.args.length, 5, 'rewriting twice is a no-op');

  for (const request of [
    { method: 'provider/usage', params: { providerOptions: { acpLaunchSpec: spec() } } },
    { method: 'thread/start', params: { options: { providerOptions: { agyAcpProxy: false, acpLaunchSpec: spec() } } } },
  ]) {
    resolveAntigravityLaunchSpec(request, proxy);
    const options = request.params.providerOptions ?? request.params.options.providerOptions;
    assert.notEqual(options.acpLaunchSpec.command, process.execPath);
    assert.deepEqual(options.acpLaunchSpec.args, ['acp', '--disable-telemetry']);
  }
});

test('the host module runs as the proxy process in front of the agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-proxy-run-'));
  const record = join(dir, 'received.jsonl');
  const host = fileURLToPath(new URL('../host.ts', import.meta.url));
  const agent = fileURLToPath(new URL('./fake-acp-recorder.mjs', import.meta.url));
  const child = spawn(process.execPath, [host, AGY_ACP_PROXY_FLAG, process.execPath, agent], {
    env: { ...process.env, RECORD_FILE: record, [AGY_ACP_PROXY_STATE_DIR_ENV]: join(dir, 'state') },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const replies = new Map();
    createInterface({ input: child.stdout }).on('line', l => { const m = JSON.parse(l); replies.get(m.id)?.(m); });
    const call = (id, method, params) => new Promise(resolve => { replies.set(id, resolve); child.stdin.write(line({ id, method, params }) + '\n'); });
    await call(1, 'initialize', { protocolVersion: 1 });
    await call(2, 'session/new', { cwd: dir, mcpServers: [] });
    const result = await call(3, 'session/prompt', { sessionId: 'rec-session', prompt: [{ type: 'text', text: BLOCK }, { type: 'text', text: 'hi' }] });
    assert.equal(result.result.stopReason, 'end_turn');
    const received = readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(received.map(m => m.method), ['initialize', 'session/new', 'session/resume', 'session/prompt']);
    assert.deepEqual(received[2].params._meta, { antigravity: { systemPrompt: { append: 'Use bb rules.' } } });
    assert.deepEqual(received[3].params.prompt, [{ type: 'text', text: 'hi' }]);
    assert.deepEqual(readdirSync(join(dir, 'state')), ['rec-session.json']);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recognizes an agy CLI too old for acp', () => {
  assert.deepEqual(parseAgyVersion('1.5.14\n'), [1, 5, 14]);
  assert.deepEqual(parseAgyVersion('agy version 1.1.24 (abc)'), [1, 1, 24]);
  assert.equal(parseAgyVersion('dev build'), undefined);
  assert.equal(isAgyVersionTooOld([1, 1, 24]), true);
  assert.equal(isAgyVersionTooOld([1, 4, 99]), true);
  assert.equal(isAgyVersionTooOld([1, 5, 0]), false);
  assert.equal(isAgyVersionTooOld([2, 0, 0]), false);
  assert.match(describeOutdatedAgy('/bin/agy', () => '1.1.24'), /Antigravity CLI 1\.1\.24 \(\/bin\/agy\) is too old for bb: `agy acp` needs 1\.5\.0 or later\. Run `agy update`/);
  assert.equal(describeOutdatedAgy('/bin/agy', () => '1.5.14'), undefined);
  assert.equal(describeOutdatedAgy('/bin/agy', () => { throw new Error('ENOENT'); }), undefined);
});

test('the proxy explains an outdated agy before its own error', { skip: process.platform === 'win32' }, async () => {
  const agent = fileURLToPath(new URL('./fake-old-agy.mjs', import.meta.url));
  chmodSync(agent, 0o755);
  const host = fileURLToPath(new URL('../host.ts', import.meta.url));
  const child = spawn(process.execPath, [host, AGY_ACP_PROXY_FLAG, agent, 'acp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 2);
  const lines = stderr.trim().split('\n');
  assert.match(lines[0], /Antigravity CLI 1\.1\.24 .* is too old for bb/);
  assert.equal(lines[1], 'Error: unexpected argument "acp".');
});
