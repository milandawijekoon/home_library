// `node server.js` as a user runs it: environment variables, start-up messages, exit codes, shutdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

function run(testContext, env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, OPEN_LIBRARY: 'off', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { output: '', exited: new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal }))) };
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { run.output += chunk; });
  run.until = async (pattern, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    while (!pattern.test(run.output)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${pattern}; output so far:\n${run.output}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  run.child = child;
  testContext.after(() => child.kill('SIGKILL'));
  return run;
}

async function scratchDir(testContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'home_library-main-'));
  testContext.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('starts on PORT with BOOKS_FILE, serves the app, and shuts down cleanly on SIGTERM', async (testContext) => {
  const directory = await scratchDir(testContext);
  const file = path.join(directory, 'books.json');
  const port = await freePort();
  const server = run(testContext, { PORT: String(port), BOOKS_FILE: file, GOOGLE_BOOKS_API_KEY: 'test-key' });
  await server.until(/Shelfie is running at http:\/\/localhost:\d+/);
  assert.match(server.output, /\(0 books\)/);
  assert.ok(server.output.includes(file));
  assert.doesNotMatch(server.output, /Warning/); // loopback only

  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.lookupKeyConfigured, true);
  assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /Shelfie Home Library/);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { books: [] }); // created at start-up

  server.child.kill('SIGTERM');
  const exit = await server.exited;
  // Windows has no POSIX signals: kill() terminates the process outright, so there is no handler to run.
  if (process.platform === 'win32') assert.ok(exit.code === 0 || exit.signal === 'SIGTERM');
  else assert.deepEqual(exit, { code: 0, signal: null });
});

test('refuses to start on a corrupt library file and leaves it untouched', async (testContext) => {
  const directory = await scratchDir(testContext);
  const file = path.join(directory, 'books.json');
  await fs.writeFile(file, '{"books": [ {oops');
  const server = run(testContext, { PORT: String(await freePort()), BOOKS_FILE: file });
  const { code } = await server.exited;
  assert.equal(code, 1);
  assert.match(server.output, /not valid JSON/);
  assert.equal(await fs.readFile(file, 'utf8'), '{"books": [ {oops');
});

test('a port that is already taken exits with a helpful message', async (testContext) => {
  const directory = await scratchDir(testContext);
  const port = await freePort();
  const blocker = net.createServer().listen(port, '127.0.0.1');
  testContext.after(() => blocker.close());
  await new Promise((resolve) => blocker.once('listening', resolve));
  const server = run(testContext, { PORT: String(port), BOOKS_FILE: path.join(directory, 'books.json') });
  assert.equal((await server.exited).code, 1);
  assert.match(server.output, new RegExp(`Port ${port} is already in use`));
});
