// Show upstream drift for every installed shadcn/ui component.
//
//   npm run ui:diff              — diff all components against the registry
//   npm run ui:diff -- button    — diff just one
//
// Read-only: uses `shadcn add --diff`, never writes. To actually update a
// component, follow the smart-merge flow in src/renderer/CLAUDE.md
// ("Reusable UI primitives"): `npx shadcn@latest add <name> --dry-run`,
// review the diff, then merge by hand (or --overwrite if there are no local
// changes).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = join(root, 'src', 'renderer', 'components', 'ui');

const requested = process.argv.slice(2);
const installed = readdirSync(uiDir)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => basename(f, '.tsx'));
const targets = requested.length > 0 ? requested : installed;

let drifted = 0;
for (const name of targets) {
  const res = spawnSync('npx', ['shadcn@latest', 'add', name, '--diff'], {
    cwd: root,
    encoding: 'utf8',
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  // A matching component prints "<file> (skip) / No changes." — anything else
  // (a diff hunk, "(update)", a registry error) is worth showing.
  const hasDiff = !out.includes('No changes.');
  if (hasDiff) {
    drifted++;
    console.log(`\n━━━ ${name} ━━━`);
    console.log(out);
  } else {
    console.log(`✓ ${name} — up to date`);
  }
}
console.log(`\n${targets.length} checked, ${drifted} drifted.`);
