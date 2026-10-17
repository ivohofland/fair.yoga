// Proves the runner image can load Prisma's query engine. CI pipes this into
// the image over stdin (`docker run -i --entrypoint node <image> -`) because
// the runner image carries no scripts/ directory.
//
// The generated client exists in the runner only inside the standalone
// bundle, so the probe cannot require it: it boots the bundle's server.js and
// asks the health route to reach a database. The address is RFC 5737
// TEST-NET-3: nothing can answer it, so a client that loaded its engine fails
// at the network. The route logs that failure as `health check: database
// probe failed`, and the probe passes only when the logged message is Prisma's
// can't-reach-database text.
//
// It matches the message, not a code: the route logs the error's message and
// not its code, and a client whose engine is missing fails with a different
// message, so the text alone tells the two apart.
const { spawn } = require('node:child_process');

const UNREACHABLE = 'postgresql://u:p@203.0.113.1:5432/none?connect_timeout=3';
const PORT = '3999';
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
const PROBE_MSG = 'health check: database probe failed';
const REACH_FAILURE = "Can't reach database server at `203.0.113.1:5432`";
const ENGINE_MISSING = 'could not locate the Query Engine';

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

let output = '';
server.stdout.on('data', (chunk) => {
  output += chunk;
});
server.stderr.on('data', (chunk) => {
  output += chunk;
});
server.on('error', (err) => finish(1, `could not start server.js: ${err}`));
server.on('exit', (code, signal) => {
  finish(1, `server.js exited early (code ${code}, signal ${signal})`);
});

let finished = false;
function finish(code, message) {
  if (finished) return;
  finished = true;
  if (code === 0) {
    console.log(message);
  } else {
    console.error(`prisma-engine-probe: ${message}`);
    console.error(output);
  }
  server.removeAllListeners('exit');
  server.kill();
  process.exit(code);
}

// A server that never answers, or never logs, must not hang the CI job. The
// timer is referenced on purpose: with the child's pipes closed and nothing
// else holding the event loop, Node would drain it and exit 0 with no output;
// the live timer turns that into this failure.
setTimeout(() => finish(1, 'timed out waiting for the server'), 60_000);

// The route's log line is JSON from pino; an unparseable line is not ours.
function probeFailureMessage() {
  for (const line of output.split('\n')) {
    if (!line.includes(PROBE_MSG)) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.msg !== PROBE_MSG) continue;
      return String(entry.err?.message ?? '');
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
      await fetch(HEALTH_URL);
      break;
    } catch {
      await sleep(250);
    }
  }
  let message = probeFailureMessage();
  while (message === null) {
    await sleep(100);
    message = probeFailureMessage();
  }
  if (message.includes(REACH_FAILURE)) {
    finish(0, 'engine loaded; connect failed with P1001 as expected');
  } else if (output.includes(ENGINE_MISSING)) {
    finish(1, 'the query engine did not load: the bundle has no engine for this platform');
  } else {
    finish(1, `the health probe failed with an unexpected message: ${message}`);
  }
})();
