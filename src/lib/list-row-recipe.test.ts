import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const RECIPE = 'min-h-14';
const OWNER = 'components/ui/list-row.tsx';

// Sites that split the row recipe across two elements. Each is a different
// geometry from ListRow, and migrating it would change a real page.
const SPLIT_RECIPE_SITES: Readonly<Record<string, string>> = {
  'components/class/outstanding-payment-row.tsx':
    'border and py-2 sit on a wrapper and min-h-14 on the inner row, so its minimum is 72px, not 56',
  'components/account/install-app-row.tsx':
    'the wrapper holds the border so the row can expand to show install steps under its button',
  'components/class/audience-picker.tsx':
    'a checklist label inside a bordered box: px-4, no vertical padding, the border on its li',
  'app/(student)/bookings/[classId]/pay/page.tsx':
    'a disclosure: the border sits on <details> so an open panel stays above it; min-h-14 and py-3 sit on <summary> so the tap target alone is 56px',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [full] : [];
  });
}

const usingRecipe = sourceFiles(SRC)
  .filter((file) => readFileSync(file, 'utf8').includes(RECIPE))
  .map((file) => path.relative(SRC, file).split(path.sep).join('/'));

describe('the directory-row recipe has one owner', () => {
  it('appears only in ListRow and the split-recipe sites', () => {
    const strays = usingRecipe.filter((file) => file !== OWNER && !(file in SPLIT_RECIPE_SITES));
    expect(strays).toEqual([]);
  });

  it('names no split-recipe site that no longer uses it', () => {
    const stale = Object.keys(SPLIT_RECIPE_SITES).filter((file) => !usingRecipe.includes(file));
    expect(stale).toEqual([]);
  });

  it('is still owned by ListRow', () => {
    expect(usingRecipe).toContain(OWNER);
  });
});
