import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The browser scripts are not imported by any other test, so a syntax error
// in one would otherwise ship and leave the whole UI blank.
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

for (const file of readdirSync(publicDir).filter((name) => name.endsWith('.js'))) {
  test(`public/${file} parses`, () => {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', publicDir + file], { stdio: 'pipe' }));
  });
}
