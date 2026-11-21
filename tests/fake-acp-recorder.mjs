// What: a minimal fake ACP agent that records every message it receives, for the proxy process test.
// Why: proves the proxy, run as a separate process, rewrites what agy receives.
// Design notes: appends each received line to the file named in RECORD_FILE; answers only what the test needs.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  appendFileSync(process.env.RECORD_FILE, line + '\n');
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'rec-session' } });
  if (m.method === 'session/resume') send({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'session/prompt') send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
});
