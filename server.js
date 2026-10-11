import crypto from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse, resolveDownloadUrl } from './aio.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = dirname(fileURLToPath(import.meta.url));
const TOKEN_KEY = crypto.randomBytes(32);
const TOKEN_LIFETIME = 15 * 60 * 1000;
const MAX_BODY = 16 * 1024;

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);

const requestLog = new Map();

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : 'Terjadi kesalahan tak terduga';
  if (/fetch failed|ENOTFOUND|ECONN/i.test(message)) {
    return 'Layanan extractor sedang tidak dapat dihubungi. Coba beberapa saat lagi.';
  }
  return message;
}

function rateLimited(ip) {
  const now = Date.now();
  const history = (requestLog.get(ip) || []).filter(time => now - time < 60_000);
  if (history.length >= 20) return true;
  history.push(now);
  requestLog.set(ip, history);
  return false;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY) throw new Error('Permintaan terlalu besar');
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new Error('Format permintaan tidak valid');
  }
}

function createToken(resourceContent) {
  const payload = Buffer.from(JSON.stringify({
    resourceContent,
    expiresAt: Date.now() + TOKEN_LIFETIME
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', TOKEN_KEY).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) throw new Error('Pilihan unduhan tidak valid');
  const [payload, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_KEY).update(payload).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    throw new Error('Pilihan unduhan tidak valid');
  }
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (Date.now() > decoded.expiresAt) throw new Error('Pilihan sudah kedaluwarsa. Analisis URL kembali.');
  return decoded.resourceContent;
}

async function analyze(req, res) {
  const { url } = await readJson(req);
  const result = await parse(url);
  json(res, 200, {
    ...result,
    resources: result.resources.map(({ resource_content, ...resource }) => ({
      ...resource,
      token: createToken(resource_content)
    }))
  });
}

async function resolve(req, res) {
  const { token, outputFormat } = await readJson(req);
  const resourceContent = readToken(token);
  const result = await resolveDownloadUrl(resourceContent, { outputFormat });
  json(res, 200, { status: true, url: result.direct_url || result.download_link });
}

async function serveStatic(pathname, res) {
  const entry = staticFiles.get(pathname);
  if (!entry) return false;
  const [filename, contentType] = entry;
  const content = await readFile(join(ROOT, 'public', filename));
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': pathname === '/' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  });
  res.end(content);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { status: true, service: 'AllFetch' });
    }

    if (url.pathname.startsWith('/api/')) {
      const ip = req.socket.remoteAddress || 'unknown';
      if (rateLimited(ip)) return json(res, 429, { status: false, error: 'Terlalu banyak permintaan. Tunggu satu menit.' });
      if (req.method === 'POST' && url.pathname === '/api/analyze') return await analyze(req, res);
      if (req.method === 'POST' && url.pathname === '/api/resolve') return await resolve(req, res);
      return json(res, 404, { status: false, error: 'Endpoint tidak ditemukan' });
    }

    if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
    json(res, 404, { status: false, error: 'Halaman tidak ditemukan' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}]`, error);
    json(res, 400, { status: false, error: friendlyError(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AllFetch siap di http://${HOST}:${PORT}`);
});
