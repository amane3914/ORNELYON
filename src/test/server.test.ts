import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startServer, type RunningServer } from '../interface/server.js';
import { defaultConfig, saveConfig } from '../core/config.js';
import { configPath } from '../core/paths.js';
import { isolatedHome } from './helpers.js';

interface Reply {
  status: number;
  body: string;
}

/** Use node:http directly so the Host header can be set (fetch does not allow it). */
function call(port: number, path: string, opts: { method?: string; token?: string; host?: string; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: {
          host: opts.host ?? `127.0.0.1:${port}`,
          ...(opts.token ? { 'x-chimera-token': opts.token } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function withServer(fn: (srv: RunningServer, port: number) => Promise<void>): Promise<void> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = await startServer(port);
  try {
    await fn(srv, port);
  } finally {
    await srv.close();
  }
}

test('gui: the page is served with the session token injected', async () => {
  isolatedHome();
  await withServer(async (srv, port) => {
    const r = await call(port, '/');
    assert.equal(r.status, 200);
    assert.match(r.body, /ORNELYON Setup/);
    assert.ok(!r.body.includes('__CHIMERA_TOKEN__'));
    assert.ok(r.body.includes(srv.token));
  });
});

test('gui: API calls without the session token are refused', async () => {
  isolatedHome();
  await withServer(async (_srv, port) => {
    const r = await call(port, '/api/config');
    assert.equal(r.status, 401);
  });
});

test('gui: a wrong token is refused', async () => {
  isolatedHome();
  await withServer(async (_srv, port) => {
    const r = await call(port, '/api/config', { token: 'wrong-token' });
    assert.equal(r.status, 401);
  });
});

test('gui: a foreign Host header (DNS rebinding) is refused even with the token', async () => {
  isolatedHome();
  await withServer(async (srv, port) => {
    const r = await call(port, '/api/config', { token: srv.token, host: 'attacker.example' });
    assert.equal(r.status, 403);
  });
});

test('gui: with a valid token, config reads and writes work, and setup cannot be completed by editing config', async () => {
  isolatedHome();
  await withServer(async (srv, port) => {
    const read = await call(port, '/api/config', { token: srv.token });
    assert.equal(read.status, 200);
    const config = JSON.parse(read.body).config as ReturnType<typeof defaultConfig>;
    assert.equal(config.setupCompleted, false);

    config.setupCompleted = true;
    config.multiAi.enabled = true;
    const write = await call(port, '/api/config', { method: 'PUT', token: srv.token, body: { config } });
    assert.equal(write.status, 200);
    const saved = JSON.parse(write.body).config as ReturnType<typeof defaultConfig>;
    assert.equal(saved.setupCompleted, false, 'setupCompleted can only be set by /api/setup/complete');
    assert.equal(saved.multiAi.enabled, true);
  });
});

test('gui: a task cannot start before setup is complete', async () => {
  isolatedHome();
  await withServer(async (srv, port) => {
    const r = await call(port, '/api/tasks', { method: 'POST', token: srv.token, body: { prompt: 'hi' } });
    assert.equal(r.status, 409);
  });
});

test('gui: invalid task input is rejected before anything runs', async () => {
  isolatedHome();
  saveConfig({ ...defaultConfig(), setupCompleted: true }, configPath());
  await withServer(async (srv, port) => {
    const empty = await call(port, '/api/tasks', { method: 'POST', token: srv.token, body: { prompt: '   ' } });
    assert.equal(empty.status, 400);
    const badSandbox = await call(port, '/api/tasks', { method: 'POST', token: srv.token, body: { prompt: 'hi', sandbox: 'danger-full-access' } });
    assert.equal(badSandbox.status, 400);
    const badCwd = await call(port, '/api/tasks', { method: 'POST', token: srv.token, body: { prompt: 'hi', cwd: '../../..' } });
    assert.equal(badCwd.status, 400, 'paths outside the workspace are refused');
  });
});

test('gui: unknown API routes return 404 without a stack trace', async () => {
  isolatedHome();
  await withServer(async (srv, port) => {
    const r = await call(port, '/api/nope', { token: srv.token });
    assert.equal(r.status, 404);
    assert.ok(!r.body.includes('at '));
  });
});
