import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
const ROOT = process.env.MI_ROOT || process.cwd();
export const UPLOAD_MAX_BYTES = Number(process.env.MI_UPLOAD_MAX_BYTES || 10 * 1024 * 1024);
export const UPLOAD_TTL_MS = Number(process.env.MI_UPLOAD_TTL_MS || 15 * 60 * 1000);
export const UPLOAD_RETENTION_MS = Number(process.env.MI_UPLOAD_RETENTION_MS || 7 * 24 * 60 * 60 * 1000);
export const UPLOAD_DIR = process.env.MI_UPLOAD_DIR || join(ROOT, 'state', 'uploads', 'files');
const TOKEN_PATH = process.env.MI_UPLOAD_TOKEN_PATH || join(ROOT, 'state', 'uploads', 'tokens.json');
const IMAGE_TYPES = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
};
export function uploadPublicBaseUrl() {
    return (process.env.MI_PUBLIC_BASE_URL || `http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 8787}`).replace(/\/$/, '');
}
async function readTokens() {
    try {
        return JSON.parse(await readFile(TOKEN_PATH, 'utf8'));
    }
    catch {
        return [];
    }
}
async function writeTokens(tokens) {
    await mkdir(dirname(TOKEN_PATH), { recursive: true });
    await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}
export async function createUploadLink(baseUrl = uploadPublicBaseUrl()) {
    await cleanupUploads().catch(() => undefined);
    const token = randomBytes(24).toString('base64url');
    const now = Date.now();
    const record = { token, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + UPLOAD_TTL_MS).toISOString(), used: false };
    const tokens = (await readTokens()).filter((item) => Date.parse(item.expiresAt) > now && !item.used);
    tokens.push(record);
    await writeTokens(tokens);
    return { token, expiresAt: record.expiresAt, maxBytes: UPLOAD_MAX_BYTES, url: `${baseUrl}/u/${token}` };
}
export function safeImageName(original, contentType) {
    const clean = basename(original || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80);
    const wanted = extname(clean).toLowerCase();
    const ext = IMAGE_TYPES[contentType.toLowerCase()];
    if (!ext)
        throw new Error('Only JPEG, PNG, GIF, and WebP images are allowed.');
    const stem = (wanted ? clean.slice(0, -wanted.length) : clean).replace(/\.+$/, '') || 'image';
    return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}-${stem}${ext}`;
}
export function sniffImage(buffer, contentType) {
    if (contentType === 'image/jpeg')
        return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (contentType === 'image/png')
        return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (contentType === 'image/gif')
        return buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a';
    if (contentType === 'image/webp')
        return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    return false;
}
export async function consumeUpload(token, body, contentType, originalName = 'image') {
    if (!/^[A-Za-z0-9_-]{32}$/.test(token))
        throw new Error('Bad upload token.');
    if (body.length === 0)
        throw new Error('Empty upload.');
    if (body.length > UPLOAD_MAX_BYTES)
        throw new Error(`Image is too large; max ${UPLOAD_MAX_BYTES} bytes.`);
    const type = contentType.split(';')[0].trim().toLowerCase();
    if (!sniffImage(body, type))
        throw new Error('Upload is not a valid supported image.');
    const now = Date.now();
    const tokens = await readTokens();
    const record = tokens.find((item) => item.token === token);
    if (!record || record.used || Date.parse(record.expiresAt) <= now)
        throw new Error('Upload link expired or already used.');
    const filename = safeImageName(originalName, type);
    await mkdir(UPLOAD_DIR, { recursive: true });
    const dest = resolve(UPLOAD_DIR, filename);
    if (!dest.startsWith(resolve(UPLOAD_DIR) + '/'))
        throw new Error('Unsafe upload path.');
    await writeFile(dest, body, { flag: 'wx' });
    record.used = true;
    await writeTokens(tokens.filter((item) => !item.used && Date.parse(item.expiresAt) > now));
    return { filename, url: `${uploadPublicBaseUrl()}/uploads/${encodeURIComponent(filename)}` };
}
export async function cleanupUploads(now = Date.now()) {
    const tokens = (await readTokens()).filter((item) => !item.used && Date.parse(item.expiresAt) > now);
    await writeTokens(tokens);
    try {
        for (const name of await readdir(UPLOAD_DIR)) {
            const path = join(UPLOAD_DIR, name);
            const s = await stat(path);
            if (now - s.mtimeMs > UPLOAD_RETENTION_MS)
                await rm(path, { force: true });
        }
    }
    catch { }
}
