// Proves the runner image's bundle can construct a Prisma client, hand a query
// to the pg driver adapter, and have pg try the network. CI pipes this into the
// image over stdin (`docker run -i --entrypoint node <image> -`) because the
// runner image carries no scripts/ directory.
//
// The generated client exists in the runner only inside the standalone
// bundle, so the probe cannot require it: it boots the bundle's server.js and
// asks the health route to reach a database. The address is RFC 5737
// TEST-NET-3 and the container has no network, so a client that loaded fails
// at the network. The probe waits for a server log line whose `msg` is
// `health check: database probe failed` and passes only when that line's
// error is a PrismaClientKnownRequestError carrying pg's ENETUNREACH.
//
// The success check reads the logged error's `type` and `code`, never its
// message, which the log withholds. A module missing from the bundle is
// recognised by the bundler's own `Failed to load external module` text in
// the server's output, because that error carries no code. Why, and what each
// failure looks like, is in docs/supply-chain.md, "Prisma's engine in the
// images".
const { spawn } = require('node:child_process');

const UNREACHABLE = 'postgresql://u:p@203.0.113.1:5432/none';
const PORT = '3999';
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
const PROBE_MSG = 'health check: database probe failed';
const EXTERNAL_MISSING = 'Failed to load external module';

const server = spawn(process.execPath, ['server.js'], {
  cwd: '/app',
  env: {
    ...process.env,
    DATABASE_URL: UNREACHABLE,
    PORT,
    HOSTNAME: '127.0.0.1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// `stdoutText` is what the log parser reads; `output` adds stderr for the
// import-failure check and the failure dump.
let output = '';
let stdoutText = '';
server.stdout.setEncoding('utf8');
server.stderr.setEncoding('utf8');
server.stdout.on('data', (chunk) => {
  stdoutText += chunk;
  output += chunk;
});
server.stderr.on('data', (chunk) => {
  output += chunk;
});
server.on('error', (err) => finish(1, `could not start server.js: ${err}`));
server.on('close', (code, signal) => {
  finish(1, `server.js exited early (code ${code}, signal ${signal})`);
});

let finished = false;
function finish(code, message) {
  if (finished) return;
  finished = true;
  if (code === 0) {
    console.log(message);
  } else {
    console.error(`prisma-client-probe: ${message}`);
    console.error(output);
  }
  server.removeAllListeners('close');
  server.kill();
  process.exit(code);
}

// A server that never answers, or never logs, must not hang the CI job. The
// timer is referenced on purpose: with the child's pipes closed and nothing
// else holding the event loop, Node would drain it and exit 0 with no output;
// the live timer turns that into this failure.
let phase = 'the health route to answer';
let lastFetchError = null;
setTimeout(() => {
  const detail = lastFetchError === null ? '' : `; last fetch error: ${lastFetchError}`;
  finish(1, `timed out waiting for ${phase}${detail}`);
}, 60_000);

// The route's log line is JSON from pino; an unparseable line is not ours.
function probeFailure() {
  for (const line of stdoutText.split('\n')) {
    if (!line.includes(PROBE_MSG)) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.msg !== PROBE_MSG) continue;
      return { type: entry.err?.type, code: entry.err?.code };
    } catch {
      // not a JSON log line
    }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  for (;;) {
    try {
      await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
      break;
    } catch (err) {
      lastFetchError = String(err);
      if (output.includes(EXTERNAL_MISSING)) {
        finish(1, 'a module failed to load at import, before the health route ran');
        return;
      }
      await sleep(250);
    }
  }
  phase = `the log line "${PROBE_MSG}"`;
  let failure = probeFailure();
  while (failure === null) {
    if (output.includes(EXTERNAL_MISSING)) {
      finish(1, 'a module failed to load at import, before the health route ran');
      return;
    }
    await sleep(100);
    failure = probeFailure();
  }
  if (failure.type === 'PrismaClientKnownRequestError' && failure.code === 'ENETUNREACH') {
    // The success line is the fixed marker .github/workflows/ci.yml greps for.
    finish(0, 'client loaded; database unreachable with ENETUNREACH as expected');
  } else if (output.includes(EXTERNAL_MISSING)) {
    finish(1, 'the Prisma client could not load a module it imports lazily (the query compiler): the bundle is missing it');
  } else {
    finish(1, `the health probe failed with type ${failure.type} and code ${failure.code}, expected PrismaClientKnownRequestError and ENETUNREACH`);
  }
})().catch((err) => finish(1, `probe threw: ${err}`));
