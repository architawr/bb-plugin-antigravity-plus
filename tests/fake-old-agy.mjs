#!/usr/bin/env node
// What: a fake pre-1.5 agy CLI for the proxy's outdated-CLI test.
// Why: agy 1.1.24 has no `acp` subcommand; it exits 2 with "unexpected argument" and reports its version.
if (process.argv[2] === '--version') {
  console.log('1.1.24');
} else {
  console.error('Error: unexpected argument "acp".');
  process.exit(2);
}
