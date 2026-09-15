import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractImageReferences, parseImagePin } from './service-image-freshness';
import { scanWorkflows } from './service-image-scan';

const root = process.cwd();

// Builds a throwaway `<root>/.github/workflows/` directory so scanWorkflows's
// three branches (coverageGaps, unparsed, pins) can each be exercised without
// touching this repo's real workflow files. Callers must rmSync the returned
// root in a finally block.
function makeWorkflowsFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'scan-workflows-'));
  const workflowsDir = join(dir, '.github', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(workflowsDir, name), contents);
  }
  return dir;
}

describe('scanWorkflows', () => {
  it('collects a digest-pinned reference into pins, tagged with its file', () => {
    const digest = 'a'.repeat(64);
    const fixtureRoot = makeWorkflowsFixture({
      'ci.yml': `services:\n  postgres:\n    image: postgres:16-alpine@sha256:${digest}\n`,
    });
    try {
      const { pins, unparsed, coverageGaps } = scanWorkflows(fixtureRoot);
      expect(pins).toEqual([{ image: 'postgres', tag: '16-alpine', digest: `sha256:${digest}`, file: 'ci.yml' }]);
      expect(unparsed).toEqual([]);
      expect(coverageGaps).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('collects a non-digest-pinned reference into unparsed, tagged with its file and the raw reference', () => {
    const fixtureRoot = makeWorkflowsFixture({
      'ci.yml': 'services:\n  postgres:\n    image: postgres:16-alpine\n',
    });
    try {
      const { pins, unparsed, coverageGaps } = scanWorkflows(fixtureRoot);
      expect(pins).toEqual([]);
      expect(unparsed).toEqual([{ file: 'ci.yml', reference: 'postgres:16-alpine' }]);
      expect(coverageGaps).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('reports a coverage gap when an image: key line yields no extracted reference (e.g. an indented continuation line)', () => {
    const fixtureRoot = makeWorkflowsFixture({
      'ci.yml': 'services:\n  postgres:\n    image:\n      postgres:16-alpine\n',
    });
    try {
      const { pins, unparsed, coverageGaps } = scanWorkflows(fixtureRoot);
      expect(pins).toEqual([]);
      expect(unparsed).toEqual([]);
      expect(coverageGaps).toEqual([{ file: 'ci.yml', imageKeyLines: 1, referencesFound: 0 }]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('scans every .yml/.yaml file in the directory, ignoring other extensions', () => {
    const digest = 'b'.repeat(64);
    const fixtureRoot = makeWorkflowsFixture({
      'a.yml': `image: x:1@sha256:${digest}\n`,
      'b.yaml': `image: y:2@sha256:${digest}\n`,
      'README.md': 'image: z:3@sha256:' + digest + '\n',
    });
    try {
      const { pins } = scanWorkflows(fixtureRoot);
      expect(pins.map((p) => p.file).sort()).toEqual(['a.yml', 'b.yaml']);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  // Tethered to the real artifacts, the way parsePackageManagerPin's test
  // reads package.json directly — if #603's digest pins are ever hand-edited
  // back to a floating tag, this fails immediately instead of the check
  // going quietly inert. Replaces service-image-freshness.test.ts's former
  // inline re-implementation of this same scan (#609): calls the real
  // scanWorkflows instead of readdirSync + extractImageReferences +
  // parseImagePin duplicated in the test.
  it("parses every image: reference this repo currently ships under .github/workflows, all matching docker-compose.yml's pinned digest", () => {
    const { pins, unparsed, coverageGaps } = scanWorkflows(root);
    expect(coverageGaps).toEqual([]);
    expect(unparsed).toEqual([]);
    expect(pins.length).toBeGreaterThanOrEqual(4);

    const composeContent = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
    const composePin = extractImageReferences(composeContent).map(parseImagePin).find((pin) => pin !== null);
    expect(composePin).not.toBeNull();

    for (const pin of pins) {
      expect(pin.digest).toBe(composePin?.digest);
    }
  });

  it('the fixture helper itself only ever writes files scanWorkflows can see, sanity-checked against a real readdirSync', () => {
    const fixtureRoot = makeWorkflowsFixture({ 'x.yml': 'image: a:1\n' });
    try {
      const workflowsDir = join(fixtureRoot, '.github', 'workflows');
      expect(readdirSync(workflowsDir)).toEqual(['x.yml']);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
