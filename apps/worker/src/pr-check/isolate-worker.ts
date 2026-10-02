import { parentPort } from 'node:worker_threads';
import { analyze, selectFiles } from './analysis';

// The isolate's entry (a worker thread; see isolate.ts). Bundled as dist/pr-check-isolate.js.
// Replies carry the result or only the error's name: nothing from the input leaves in an error.

const port = parentPort;
if (!port) throw new Error('pr-check-isolate runs only as a worker thread');

port.on('message', async (message: { id: number; task: 'select' | 'analyze'; input: never }) => {
  try {
    const output = message.task === 'select' ? selectFiles(message.input) : await analyze(message.input);
    port.postMessage({ id: message.id, ok: true, output });
  } catch (error) {
    port.postMessage({ id: message.id, ok: false, name: error instanceof Error ? error.name : 'Error' });
  }
});
port.postMessage({ ready: true });
