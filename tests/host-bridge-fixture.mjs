import { createInterface } from 'node:readline';
import { experimental_providerBridge as bridge } from '../host.ts';

bridge.start();
const input = createInterface({ input: process.stdin });
input.on('line', line => bridge.handleLine(line));
input.on('close', () => bridge.onClose());
