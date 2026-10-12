import crypto from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { download } from './aio.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = dirname(fileURLToPath(import.meta.url));
const TOKEN_KEY = crypto.randomBytes(32);
const TOKEN_LIFETIME = 15 * 60 * 1000;
const MAX_BODY = 16 * 1024;

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml; charset=utf-8']],
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
  if (/(?:vidssave|savefrom) (?:parse (?:error|failed)|worker hub error)/i.test(message)) {
    return 'Tautan tidak dapat dianalisis. Pastikan konten bersifat publik lalu coba kembali.';
  }
  if (/vidssave (?:media\/download request|download task) failed/i.test(message)) {
    return 'Link unduhan gagal disiapkan. Silakan coba kembali.';
  }
  if (/vidssave SSE (?:query failed|stream completed)/i.test(message)) {
    return 'Link unduhan belum tersedia. Silakan tekan unduh kembali.';
  }
  return message.replace(/vidssave|savefrom/gi, 'Layanan extractor');
}

function rateLimited(ip) {
  const now = Date.now();
  const history = (requestLog.get(ip) || []).filter(time => now - time < 60_000);
  if (history.length >= 20) return true;
  history.push(now);
  requestLog.set(ip, history);
  return false;
}

function normalizeInputUrl(value) {
  if (typeof value !== 'string') return value;
  const input = value.trim();

  try {
    const parsed = new URL(input);
    const hostname = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
    let videoId = null;

    if (hostname === 'youtu.be') {
      videoId = parsed.pathname.split('/').filter(Boolean)[0] || null;
    } else if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      videoId = parsed.searchParams.get('v');
      if (!videoId) {
        videoId = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/)?.[1] || null;
      }
    }

    return videoId
      ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
      : input;
  } catch {
    return input;
  }
}

async function parseWithRetry(videoUrl) {
  const normalizedUrl = normalizeInputUrl(videoUrl);
  let lastError;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await download(normalizedUrl);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /vidssave|savefrom|worker hub|analy[sz]e failed|fetch failed|ENOTFOUND|ECONN/i.test(message);
      if (!retryable || attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }

  throw lastError;
}

function platformFromUrl(videoUrl) {
  try {
    const hostname = new URL(videoUrl).hostname.toLowerCase();
    if (hostname.includes('youtube') || hostname === 'youtu.be') return 'YouTube';
    if (hostname.includes('tiktok')) return 'TikTok';
    if (hostname.includes('instagram')) return 'Instagram';
    if (hostname.includes('facebook') || hostname === 'fb.watch') return 'Facebook';
  } catch {}
  return 'Media';
}

function resourceCandidates(result) {
  const values = [];
  for (const value of [result?.url, result?.stream, result?.converter]) {
    if (Array.isArray(value)) values.push(...value);
    else if (value) values.push(value);
  }

  const seen = new Set();
  return values.map((value, index) => {
    const directUrl = typeof value === 'string'
      ? value
      : value?.url || value?.download_url || value?.download || value?.link || value?.src;
    if (typeof directUrl !== 'string' || !/^https?:\/\//i.test(directUrl) || seen.has(directUrl)) return null;
    seen.add(directUrl);

    const format = String(typeof value === 'object' ? value.ext || value.format || value.type || '' : '')
      .replace(/^\./, '') || (new URL(directUrl).pathname.match(/\.([a-z0-9]+)$/i)?.[1] || 'mp4');
    const lowerFormat = format.toLowerCase();
    const isAudio = ['mp3', 'm4a', 'aac', 'opus', 'wav', 'audio'].some(item => lowerFormat.includes(item));
    const quality = typeof value === 'object'
      ? value.quality || value.qualityLabel || value.name || value.label || (isAudio ? 'Audio' : 'Auto')
      : (isAudio ? 'Audio' : `Format ${index + 1}`);

    return {
      resource_id: String(index + 1),
      quality: String(quality),
      format: format.toUpperCase(),
      type: isAudio ? 'audio' : 'video',
      size: typeof value === 'object' ? value.size || value.filesize || value.filesize_approx || null : null,
      resource_content: directUrl
    };
  }).filter(Boolean);
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
  const result = await parseWithRetry(url);
  const resources = resourceCandidates(result);
  if (resources.length === 0) throw new Error('Tidak ada format unduhan yang dikembalikan oleh extractor.');
  const meta = result.meta && typeof result.meta === 'object' ? result.meta : {};
  json(res, 200, {
    status: true,
    platform: platformFromUrl(url),
    id: result.id || null,
    title: meta.title || meta.name || result.title || 'Media tanpa judul',
    thumbnail: result.thumb || meta.thumbnail || meta.thumb || '',
    duration: meta.duration || result.duration || 0,
    resources: resources.map(({ resource_content, ...resource }) => ({
      ...resource,
      token: createToken(resource_content)
    }))
  });
}

async function resolve(req, res) {
  const { token, outputFormat } = await readJson(req);
  const directUrl = readToken(token);
  if (!/^https?:\/\//i.test(directUrl)) throw new Error('URL unduhan tidak valid');
  json(res, 200, { status: true, url: directUrl });
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
      return json(res, 200, { status: true, service: 'NoxxyDown' });
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
  console.log(`NoxxyDown siap di http://${HOST}:${PORT}`);
});
