// Test double for the official codex / claude CLIs. It is run as `node fake-agent.mjs <shape>`.
// Behaviour is chosen with FAKE_MODE: ok | auth | rate | hang | version-only.
// If FAKE_ARGS_FILE is set, the received argv and stdin are written there for assertions.
import { readFileSync, writeFileSync } from 'node:fs';

const shape = process.argv[2];
const args = process.argv.slice(3);
const mode = process.env.FAKE_MODE ?? 'ok';

let stdin = '';
try {
  stdin = readFileSync(0, 'utf8');
} catch {
  stdin = '';
}

if (process.env.FAKE_ARGS_FILE) {
  writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, stdin }));
}

const sleepForever = () => setInterval(() => {}, 1000);

if (args.includes('--version')) {
  process.stdout.write(shape === 'codex' ? 'codex-cli 0.0.0-fake\n' : '0.0.0-fake (Claude Code)\n');
  process.exit(0);
}

if (shape === 'codex' && args[0] === 'login' && args[1] === 'status') {
  if (mode === 'auth') {
    process.stderr.write('Not logged in\n');
    process.exit(1);
  }
  process.stdout.write('Logged in using fake\n');
  process.exit(0);
}

if (shape === 'claude' && args[0] === 'auth' && args[1] === 'status') {
  const loggedIn = mode !== 'auth';
  process.stdout.write(JSON.stringify({ loggedIn, authMethod: 'fake', email: 'hidden@example.invalid' }) + '\n');
  process.exit(0);
}

if (mode === 'hang') {
  sleepForever();
} else if (mode === 'auth') {
  process.stderr.write('Error: not logged in. Please log in to continue.\n');
  process.exit(1);
} else if (mode === 'rate') {
  process.stderr.write('Error 429: rate limit exceeded\n');
  process.exit(1);
} else if (shape === 'codex') {
  const text = `hello from fake codex (${stdin.length} chars received)`;
  const events = [
    { type: 'thread.started' },
    { type: 'item.completed', item: { type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } },
  ];
  process.stdout.write(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const outIndex = args.indexOf('-o');
  if (outIndex !== -1 && args[outIndex + 1]) {
    writeFileSync(args[outIndex + 1], text);
  }
  process.exit(0);
} else {
  const result = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: `hello from fake claude (${stdin.length} chars received)`,
    total_cost_usd: 0.0012,
    usage: { input_tokens: 3, output_tokens: 2 },
    modelUsage: { 'fake-model': {} },
  };
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
}
