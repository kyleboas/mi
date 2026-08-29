import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCoordinatorPiConfig } from './mi-imessage-runtime.mjs';

const root = await mkdtemp(join(tmpdir(), 'diver-auth-config-'));
try {
  const sourceDirectory = join(root, 'source');
  const stateRoot = join(root, 'state');
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  const source = join(sourceDirectory, 'auth.json');
  await writeFile(source, '{"fixture":"credential"}\n', { mode: 0o600 });

  const config = await prepareCoordinatorPiConfig(stateRoot, source);
  assert.equal(config, join(stateRoot, 'imessage', 'runtime', 'pi-config'));
  const destination = join(config, 'auth.json');
  assert.equal(await readFile(destination, 'utf8'), '{"fixture":"credential"}\n');
  assert.equal((await lstat(config)).mode & 0o777, 0o700);
  assert.equal((await lstat(destination)).mode & 0o777, 0o600);
  assert.equal(await prepareCoordinatorPiConfig(stateRoot, source), config, 'existing private copy is reused');

  const loose = join(sourceDirectory, 'loose.json');
  await writeFile(loose, '{}\n', { mode: 0o644 });
  await assert.rejects(() => prepareCoordinatorPiConfig(join(root, 'other-state'), loose), /private owned file/);
  assert.equal(await prepareCoordinatorPiConfig(join(root, 'missing-state'), join(root, 'missing.json')), undefined);
  console.log('Diver private auth config checks passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
