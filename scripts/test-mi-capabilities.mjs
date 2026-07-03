import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const temp = await mkdtemp(join(tmpdir(), 'mi-capabilities-'));
const runner = join(temp, 'runner.mjs');

await writeFile(runner, `
  import assert from 'node:assert/strict';
  import { authorizeCapability, fileGrant, principal, urlGrant } from ${JSON.stringify(new URL('../src/capabilities.ts', import.meta.url).href)};
  import { extractUrls, isBareUrlMessage, referencesFromText } from ${JSON.stringify(new URL('../src/resource-refs.ts', import.meta.url).href)};

  const p = principal('alice', 'human', 'Alice');
  const grant = fileGrant('/tmp/project', ['read'], { principal: p, recursive: true });
  assert.equal(authorizeCapability({ principal: p, resource: 'file:///tmp/project/README.md', right: 'read', tool: 'read' }, [grant]).allowed, true);
  assert.equal(authorizeCapability({ principal: p, resource: 'file:///tmp/project/secret.txt', right: 'write', tool: 'write' }, [grant]).allowed, false);
  assert.equal(authorizeCapability({ principal: p, resource: 'file:///tmp/other/README.md', right: 'read', tool: 'read' }, [grant]).allowed, false);

  const expired = fileGrant('/tmp/project', ['read'], { principal: p, recursive: true, ttlMs: -1 });
  assert.equal(authorizeCapability({ principal: p, resource: 'file:///tmp/project/README.md', right: 'read' }, [expired]).allowed, false);

  const url = urlGrant('https://example.com/story', { principal: p });
  assert.equal(authorizeCapability({ principal: p, resource: 'https://example.com/story', right: 'fetch' }, [url]).allowed, true);
  assert.equal(authorizeCapability({ principal: p, resource: 'https://example.com/other', right: 'fetch' }, [url]).allowed, false);

  assert.deepEqual(extractUrls('add https://example.com/a.'), ['https://example.com/a']);
  assert.equal(isBareUrlMessage('https://example.com/a'), true);
  assert.equal(referencesFromText('https://example.com/a').length, 0, 'bare URL alone does not mint a grant by default');
  assert.equal(referencesFromText('add this https://example.com/a').some((ref) => ref.kind === 'url'), true);
`);

const result = spawnSync(process.execPath, ['node_modules/.bin/tsx', runner], { cwd: root, encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr || result.stdout);
console.log('Mi capability model checks passed.');
