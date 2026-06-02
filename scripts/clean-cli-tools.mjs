// Remove a recursive self-link that npm (as run on the CI runners: `npm ci` at
// the root, then the cli-tools install) creates inside cli-tools' node_modules:
// `cli-tools/node_modules/shockwave` -> the root project (root package is named
// "shockwave"). It loops forever (cli-tools/node_modules/shockwave/cli-tools/…),
// which Windows 7za can't resolve during NSIS packaging ("The name of the file
// cannot be resolved by the system") → the Windows build fails. The app never
// uses it. Removing the link (not its target) is a no-op where it doesn't exist.
import { rmSync } from 'node:fs';
rmSync('cli-tools/node_modules/shockwave', { recursive: true, force: true });
console.log('[cli-tools] cleaned self-link (if present)');
