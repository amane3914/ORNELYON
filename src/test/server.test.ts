import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { readPackageVersion, renderPage, startServer, type RunningServer } from '../interface/server.js';
import { defaultConfig, saveConfig } from '../core/config.js';
import { configPath, packageRoot } from '../core/paths.js';
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

test('gui: the page shows the version from package.json and no placeholder is left', async () => {
  isolatedHome();
  const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version: string };
  assert.equal(readPackageVersion(), pkg.version);
  await withServer(async (srv, port) => {
    const r = await call(port, '/');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes(`<span id="app-version">v${pkg.version}</span>`), 'the shown version equals package.json');
    assert.ok(!r.body.includes('__ORNELYON_VERSION__'));
    assert.ok(!r.body.includes('__CHIMERA_TOKEN__'));
    // The token sits in the one place the page script reads it from, and nowhere else.
    assert.ok(r.body.includes(`const TOKEN = "${srv.token}";`));
    assert.equal(r.body.split(srv.token).length, 2);
  });
});

test('gui: the header no longer carries the old-name description or a fixed old version', async () => {
  isolatedHome();
  await withServer(async (_srv, port) => {
    const r = await call(port, '/');
    const header = r.body.slice(r.body.indexOf('<header>'), r.body.indexOf('</header>'));
    assert.match(header, /<h1>ORNELYON<\/h1>/);
    assert.ok(!/Previously named|CHIMERA Harness|NEXORA/.test(header));
    assert.ok(!header.includes('v0.3.1'));
  });
});

test('gui: unauthenticated API access is still refused after the page changes', async () => {
  isolatedHome();
  await withServer(async (srv, port) => {
    assert.equal((await call(port, '/api/config')).status, 401);
    assert.equal((await call(port, '/api/config', { token: srv.token })).status, 200);
  });
});

test('gui: renderPage fills each placeholder once and fails loudly on a template or version that does not fit', () => {
  const template = "<p>v__ORNELYON_VERSION__</p><script>const TOKEN = '__CHIMERA_TOKEN__';</script>";
  assert.equal(renderPage(template, 'ab_C-1', '1.2.3'), '<p>v1.2.3</p><script>const TOKEN = "ab_C-1";</script>');
  assert.equal(renderPage(template, 'a', '1.2.3-rc.1').includes('v1.2.3-rc.1'), true);
  // The real page has each placeholder exactly once.
  const real = readFileSync(join(packageRoot(), 'web', 'index.html'), 'utf8');
  assert.doesNotThrow(() => renderPage(real, 'tok', readPackageVersion()));
  // A template that lost, repeats or changed the quoting of a placeholder is refused.
  assert.throws(() => renderPage('<p>no placeholders</p>', 'tok', '1.2.3'), /exactly once/);
  assert.throws(() => renderPage(template + "'__CHIMERA_TOKEN__'", 'tok', '1.2.3'), /exactly once/);
  assert.throws(() => renderPage(template.replace('__ORNELYON_VERSION__', ''), 'tok', '1.2.3'), /exactly once/);
  assert.throws(() => renderPage(template.replace("'__CHIMERA_TOKEN__'", '"__CHIMERA_TOKEN__"'), 'tok', '1.2.3'), /exactly once/);
  // The version goes into HTML text, so only x.y.z[-suffix] is accepted.
  for (const bad of ['1.2.3<script>', '$&', '1.2', "1.2.3'; alert(1)//", '']) {
    assert.throws(() => renderPage(template, 'tok', bad), /Invalid version/);
  }
});

/** Pull the inline scripts out of a page. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
}

test('gui: every token that was accepted before is embedded as a script literal that restores it exactly; ASCII tokens also authenticate over HTTP', async () => {
  // Two separate claims. (1) For every token: the page is valid and the JavaScript literal in it evaluates to exactly the token.
  // (2) Only for tokens an HTTP header can carry (printable ASCII): the server accepts that token and refuses a changed one.
  // Tokens with non-ASCII text or line separators are not sent as headers, so claim (2) is not tested for them.
  isolatedHome();
  const BS = String.fromCharCode(92);
  const tokens = [
    'abc.def',
    'abc+def=',
    "it's",
    'say "hi"',
    `a${BS}b${BS}`,
    '</script><script>alert(1)</script>',
    '<!-- x',
    '$& $1 $$ $`',
    `line${String.fromCharCode(0x2028)}sep${String.fromCharCode(0x2029)}end`,
    'x__ORNELYON_VERSION__y',
    'ünï-トークン',
  ];
  // The test strings really contain the characters they are meant to test.
  assert.ok(tokens[1]?.includes('+') && tokens[1]?.endsWith('='));
  assert.ok(tokens[2]?.includes("'") && tokens[3]?.includes('"'));
  assert.equal(tokens[4]?.split(BS).length, 3);
  assert.ok(tokens[5]?.includes('</script>'));
  assert.ok(tokens[7]?.includes('$&'));
  assert.ok(tokens[8]?.includes(String.fromCharCode(0x2028)) && tokens[8]?.includes(String.fromCharCode(0x2029)));
  const template = readFileSync(join(packageRoot(), 'web', 'index.html'), 'utf8');
  const baseline = inlineScripts(template).length;
  for (const token of tokens) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const srv = await startServer(port, token);
    try {
      assert.equal(srv.token, token);
      assert.equal(srv.url, `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
      assert.equal(decodeURIComponent(new URL(srv.url).searchParams.get('token') ?? ''), token);
      const page = await call(port, '/');
      assert.equal(page.status, 200);
      assert.ok(!page.body.includes('__CHIMERA_TOKEN__'));
      assert.ok(!page.body.includes('__ORNELYON_VERSION__') || token.includes('__ORNELYON_VERSION__'));
      assert.ok(page.body.includes(`<span id="app-version">v${readPackageVersion()}</span>`));
      // The token cannot end the script or start a second one, and no raw line separator is left in the page.
      const scripts = inlineScripts(page.body);
      assert.equal(scripts.length, baseline);
      assert.ok(!page.body.includes(String.fromCharCode(0x2028)) && !page.body.includes(String.fromCharCode(0x2029)));
      // The script still compiles, and the literal evaluates to exactly the token.
      const main = scripts.find((s) => s.includes('const TOKEN = '));
      assert.ok(main);
      assert.doesNotThrow(() => new vm.Script(main));
      const literal = /const TOKEN = ("(?:[^"\\]|\\.)*");/.exec(main);
      assert.ok(literal?.[1]);
      assert.equal(JSON.parse(literal[1]), token);
      assert.equal(vm.runInNewContext(literal[1]), token);
      // Authentication uses the original value.
      // Claim (2): an HTTP header carries ASCII only, so the sign-in call is made for the tokens a client can send.
      if (/^[ -~]+$/.test(token)) {
        assert.equal((await call(port, '/api/config', { token })).status, 200);
        assert.equal((await call(port, '/api/config', { token: token + 'x' })).status, 401);
      }
      assert.equal((await call(port, '/api/config')).status, 401);
    } finally {
      await srv.close();
    }
  }
});
