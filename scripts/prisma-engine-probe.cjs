// Proves the runner image can load Prisma's query engine. CI pipes this into
// the image over stdin (`docker run -i --entrypoint node <image> -`) because
// the runner image carries no scripts/ directory.
//
// The address is RFC 5737 TEST-NET-3: nothing can answer it, so a client that
// loaded its engine fails at the network with P1001. Any other outcome means
// the engine did not load, or something answered that should not exist, and
// the probe exits non-zero.
const { createRequire } = require('node:module');

const UNREACHABLE = 'postgresql://u:p@203.0.113.1:5432/none?connect_timeout=3';

function fail(what, err) {
  console.error(`prisma-engine-probe: ${what}`);
  if (err) console.error(err);
  process.exit(1);
}

// A connect that neither fails nor succeeds must not hang the CI job. The
// timer is referenced on purpose: if the connect promise never settles and
// nothing else holds the event loop, Node would drain it and exit 0 with no
// output; the live timer turns that into this failure.
setTimeout(() => fail('timed out waiting for connect'), 30_000);

let PrismaClient;
try {
  // Resolved from /app, where the standalone bundle keeps its node_modules;
  // a stdin script has no location of its own to resolve from.
  ({ PrismaClient } = createRequire('/app/')('@prisma/client'));
} catch (err) {
  fail('could not require @prisma/client', err);
}

(async () => {
  let db;
  try {
    db = new PrismaClient({ datasources: { db: { url: UNREACHABLE } } });
  } catch (err) {
    fail('PrismaClient could not be constructed', err);
  }
  try {
    await db.$connect();
  } catch (err) {
    if (err && err.errorCode === 'P1001') {
      console.log('engine loaded; connect failed with P1001 as expected');
      process.exit(0);
    }
    fail('connect failed with something other than P1001', err);
  }
  fail('connect succeeded against an address nothing can answer');
})();
