import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(join(tmpdir(), 'mi-upload-'));
process.env.MI_ROOT = root;
process.env.MI_PUBLIC_BASE_URL = 'https://mi.test';
process.env.MI_UPLOAD_MAX_BYTES = '1024';

const { createUploadLink, consumeUpload, safeImageName } = await import('../src/uploads.ts');

const link = await createUploadLink();
assert.match(link.url, /^https:\/\/mi\.test\/u\/[A-Za-z0-9_-]{32}$/);
assert.equal(link.maxBytes, 1024);

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const result = await consumeUpload(link.token, png, 'image/png', '../../bad name.png');
assert.match(result.url, /^https:\/\/mi\.test\/uploads\//);
assert(!result.filename.includes('..'));
assert(!result.filename.includes('/'));
assert.deepEqual(await readFile(join(root, 'state', 'uploads', 'files', result.filename)), png);

await assert.rejects(() => consumeUpload(link.token, png, 'image/png', 'again.png'), /expired|already used/i);
const bad = await createUploadLink();
await assert.rejects(() => consumeUpload(bad.token, Buffer.from('not an image'), 'image/png', 'x.png'), /not a valid/i);
assert.match(safeImageName('../x<script>.jpg', 'image/jpeg'), /^[a-z0-9]+-[a-f0-9]+-x_script_\.jpg$/i);

console.log('upload tests passed');
