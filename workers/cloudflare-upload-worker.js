const IMAGE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    },
  });
}

function base64urlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hmacBase64url(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return bytesToBase64url(new Uint8Array(signature));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyToken(token, env) {
  const [body, signature] = token.split('.', 2);
  if (!body || !signature) throw new Error('Bad upload token.');
  const expected = await hmacBase64url(env.MI_UPLOAD_SIGNING_SECRET, body);
  if (!timingSafeEqual(signature, expected)) throw new Error('Bad upload token.');
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(body)));
  if (payload?.v !== 1 || typeof payload.n !== 'string' || typeof payload.exp !== 'number' || typeof payload.max !== 'number') throw new Error('Bad upload token.');
  if (Date.now() > payload.exp) throw new Error('Upload link expired.');
  return payload;
}

function sniffImage(bytes, contentType) {
  if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png') return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (contentType === 'image/gif') {
    const head = new TextDecoder('ascii').decode(bytes.slice(0, 6));
    return head === 'GIF87a' || head === 'GIF89a';
  }
  if (contentType === 'image/webp') {
    const riff = new TextDecoder('ascii').decode(bytes.slice(0, 4));
    const webp = new TextDecoder('ascii').decode(bytes.slice(8, 12));
    return riff === 'RIFF' && webp === 'WEBP';
  }
  return false;
}

function safeStem(name) {
  return (name || 'image').split('/').pop().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80).replace(/\.[^.]*$/, '') || 'image';
}

async function handleUploadPage() {
  return html(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mi image upload</title><h1>Upload image</h1><p>One-time image upload. JPEG, PNG, GIF, or WebP only.</p><input id="file" type="file" accept="image/jpeg,image/png,image/gif,image/webp"><button id="send">Upload</button><pre id="out"></pre><script>send.onclick=async()=>{const f=file.files[0];if(!f){out.textContent='Choose an image first.';return}if(!/^image\/(jpeg|png|gif|webp)$/.test(f.type)){out.textContent='Only image files are allowed.';return}out.textContent='Uploading...';const r=await fetch(location.pathname+'?filename='+encodeURIComponent(f.name),{method:'PUT',headers:{'content-type':f.type},body:f});const j=await r.json().catch(()=>({error:'Upload failed'}));out.textContent=j.url?'Uploaded image URL:\n'+j.url:(j.error||'Upload failed')};</script>`);
}

async function handleUpload(request, env, token) {
  const payload = await verifyToken(token, env);
  const usedKey = `used:${payload.n}`;
  if (await env.USED_UPLOAD_TOKENS.get(usedKey)) throw new Error('Upload link already used.');

  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(contentType) || (Array.isArray(payload.types) && !payload.types.includes(contentType))) throw new Error('Only JPEG, PNG, GIF, and WebP images are allowed.');
  const length = Number(request.headers.get('content-length') || 0);
  if (length && length > payload.max) throw new Error(`Image is too large; max ${payload.max} bytes.`);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0) throw new Error('Empty upload.');
  if (body.length > payload.max) throw new Error(`Image is too large; max ${payload.max} bytes.`);
  if (!sniffImage(body, contentType)) throw new Error('Upload is not a valid supported image.');

  const url = new URL(request.url);
  const key = `images/${payload.n}-${safeStem(url.searchParams.get('filename'))}${IMAGE_TYPES.get(contentType)}`;
  await env.IMAGES.put(key, body, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=604800, immutable' },
    customMetadata: { uploadedAt: new Date().toISOString() },
  });
  await env.USED_UPLOAD_TOKENS.put(usedKey, '1', { expirationTtl: Math.max(60, Math.ceil((payload.exp - Date.now()) / 1000) + 60) });
  const base = (env.MI_UPLOAD_PUBLIC_BASE_URL || url.origin).replace(/\/$/, '');
  return json({ key, url: `${base}/i/${encodeURIComponent(key)}`, reference: `${base}/i/${encodeURIComponent(key)}` });
}

async function handleImage(_request, env, key) {
  const object = await env.IMAGES.get(key);
  if (!object) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
      'cache-control': object.httpMetadata?.cacheControl || 'public, max-age=604800, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}

export default {
  async fetch(request, env) {
    try {
      if (!env.MI_UPLOAD_SIGNING_SECRET || !env.IMAGES || !env.USED_UPLOAD_TOKENS) return json({ error: 'Upload worker is not configured.' }, 500);
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname.startsWith('/u/')) return handleUploadPage();
      if (request.method === 'PUT' && url.pathname.startsWith('/u/')) return await handleUpload(request, env, decodeURIComponent(url.pathname.slice('/u/'.length)));
      if (request.method === 'GET' && url.pathname.startsWith('/i/')) return await handleImage(request, env, decodeURIComponent(url.pathname.slice('/i/'.length)));
      return json({ error: 'not found' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  },
};
