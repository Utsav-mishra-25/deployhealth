import { nodeIo, run } from './cli';

run(process.argv.slice(2), nodeIo()).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`deployhealth-scan: unexpected error: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
