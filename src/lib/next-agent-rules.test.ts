/**
 * Next's managed agent-rules block stays out of this repo's own docs.
 *
 * `next dev` writes that block into `AGENTS.md` — or `CLAUDE.md`, when that is
 * the file present — whenever it detects an AI coding agent. `next.config.ts`
 * sets `agentRules: false` to decline it (#539): the block's text is Next's to
 * reword, and a file whose claims this project maintains deliberately should
 * not churn on a patch release.
 *
 * WHY A TEST AND NOT ONLY THE CONFIG LINE. A *renamed* or removed upstream key
 * is already caught: `next.config.ts` annotates its object as `NextConfig`
 * rather than casting, and `tsconfig.json` includes it, so excess-property
 * checking makes `npm run typecheck` fail. A *deleted* line is not caught by
 * anything — typecheck, lint and the whole suite stay green, and the next
 * `next dev` writes the block back. That failure is silent and it argues for
 * itself: the block's own text tells the reader that committing it "keeps the
 * tree clean".
 *
 * WHAT IT ASSERTS. The outcome, not the config. Asserting the literal in
 * `next.config.ts` would restate the file and catch only what tsc already
 * catches; asserting that the markers are absent catches the deletion, and it
 * also survives Next moving or renaming the gate, because it needs to know
 * nothing about why the block would have appeared.
 *
 * WHAT IT CANNOT SEE, measured rather than assumed:
 *   - the block being written but not committed. This reads the working tree,
 *     so an uncommitted write fails it locally and passes in CI, where the
 *     checkout is clean. That is the right way round: the harm this guards
 *     against is the block becoming durable;
 *   - a block written under markers Next has not used yet. Both spellings
 *     below are read out of `generate-agent-files.js`; a third would need
 *     adding here.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// `AGENT_RULES_START_MARKER` and `LEGACY_AGENT_RULES_START_MARKER` in
// node_modules/next/dist/server/lib/generate-agent-files.js.
const NEXT_MARKERS = ['<!-- BEGIN:nextjs-agent-rules -->', '<!-- NEXT-AGENTS-MD-START -->'];

// Both are targets of `writeAgentFiles`: it prefers AGENTS.md when that exists
// and falls through to CLAUDE.md otherwise, so neither file is safe by itself.
const MANAGED_FILES = ['AGENTS.md', 'CLAUDE.md'];

describe('Next agent-rules block', () => {
  it.each(MANAGED_FILES)('is absent from %s', (name) => {
    const file = path.join(REPO_ROOT, name);
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, 'utf-8');
    for (const marker of NEXT_MARKERS) {
      expect(content).not.toContain(marker);
    }
  });

  /**
   * The directory only — not the deep guide path AGENTS.md cites, which is
   * version-shaped and will move. This is the half that has to keep resolving
   * for that section's advice to mean anything.
   */
  it('leaves the version-matched docs it advertises reachable', () => {
    expect(existsSync(path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'docs'))).toBe(true);
  });
});
