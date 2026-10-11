import crypto from 'node:crypto';

const API_BASE = 'https://api.vidssave.com';
const API_PATH = '/api/contentsite_api';
const SSE_PATH = '/sse/contentsite_api';
const AUTH_KEY = '4c9b7d21';
const DOMAIN = 'api-ak.vidssave.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const RAW_KEY = '4c9b7d2e'.repeat(3).concat('4c9b7d21');
const KEY = Buffer.from(RAW_KEY, 'utf8');
const IV = Buffer.from(RAW_KEY.slice(0, 16), 'utf8');

function decryptPayload(base64Ciphertext) {
  const ciphertext = Buffer.from(base64Ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, IV);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  let end = decrypted.length;
  while (end > 0 && decrypted[end - 1] === 0) end--;
  return JSON.parse(decrypted.slice(0, end).toString('utf8'));
}

export async function parse(videoUrl) {
  if (!videoUrl || typeof videoUrl !== 'string') {
    throw new Error('Valid video URL is required');
  }

  const params = new URLSearchParams({
    hostname: 'vidssave.com',
    auth: AUTH_KEY,
    domain: DOMAIN,
    origin: 'source',
    link: videoUrl
  });

  const res = await fetch(`${API_BASE}${API_PATH}/media/parse`, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Origin': 'https://vidssave.com',
      'Referer': 'https://vidssave.com/',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Vidssave parse failed (${res.status}): ${errorText}`);
  }

  const json = await res.json();
  if (json.status !== 1 || !json.data) {
    throw new Error(`Vidssave parse error: ${json.msg || 'Unable to parse URL'}`);
  }

  const data = typeof json.data === 'string' ? decryptPayload(json.data) : json.data;

  return {
    status: true,
    id: data.id || null,
    title: data.title || '',
    thumbnail: data.thumbnail || '',
    duration: data.duration || 0,
    resources: Array.isArray(data.resources) ? data.resources.map(r => ({
      resource_id: r.resource_id,
      quality: r.quality,
      format: r.format,
      type: r.type,
      size: r.size,
      resource_content: r.resource_content
    })) : []
  };
}

export async function resolveDownloadUrl(resourceContent, options = {}) {
  if (!resourceContent || typeof resourceContent !== 'string') {
    throw new Error('Valid resource_content is required');
  }

  const dlParams = new URLSearchParams({
    hostname: 'vidssave.com',
    auth: AUTH_KEY,
    domain: DOMAIN,
    request: resourceContent,
    no_encrypt: '1'
  });

  if (options.outputFormat) {
    dlParams.append('output', options.outputFormat);
  }

  const dlRes = await fetch(`${API_BASE}${API_PATH}/media/download`, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Origin': 'https://vidssave.com',
      'Referer': 'https://vidssave.com/',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: dlParams.toString()
  });

  if (!dlRes.ok) {
    const errorText = await dlRes.text();
    throw new Error(`Vidssave media/download request failed (${dlRes.status}): ${errorText}`);
  }

  const dlJson = await dlRes.json();
  if (dlJson.status !== 1 || !dlJson.data) {
    throw new Error(`Vidssave download task failed: ${dlJson.msg || 'Unknown error'}`);
  }

  const dlData = typeof dlJson.data === 'string' ? decryptPayload(dlJson.data) : dlJson.data;
  const taskId = dlData.task_id;
  if (!taskId) {
    throw new Error('No task_id received from Vidssave download task');
  }

  const sseUrl = `${API_BASE}${SSE_PATH}/media/download_query?auth=20250901majwlqo&domain=${DOMAIN}&task_id=${encodeURIComponent(taskId)}&download_domain=vidssave.com&origin=content_site`;

  const sseRes = await fetch(sseUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/event-stream',
      'Referer': 'https://vidssave.com/'
    }
  });

  if (!sseRes.ok) {
    throw new Error(`Vidssave SSE query failed (${sseRes.status})`);
  }

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let redirectUrl = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const dataIndex = buffer.indexOf('data:');
    if (dataIndex !== -1) {
      const jsonStr = buffer.slice(dataIndex + 5).trim();
      try {
        const sseData = JSON.parse(jsonStr);
        if (sseData.download_link) {
          redirectUrl = sseData.download_link;
          break;
        }
      } catch {}
    }
  }

  if (!redirectUrl) {
    throw new Error('Vidssave SSE stream completed without a valid download_link');
  }

  const headRes = await fetch(redirectUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': 'https://vidssave.com/'
    },
    redirect: 'manual'
  });

  const location = headRes.headers.get('location');
  return {
    download_link: redirectUrl,
    direct_url: location || redirectUrl
  };
}

export async function download(videoUrl, options = {}) {
  const parsed = await parse(videoUrl);
  if (!parsed.resources || parsed.resources.length === 0) {
    throw new Error('No downloadable resources found for this video');
  }

  let selected = null;
  if (options.quality) {
    const targetQ = String(options.quality).toLowerCase().replace('p', '');
    selected = parsed.resources.find(r => r.quality.toLowerCase().replace('p', '') === targetQ);
  }

  if (!selected && options.type) {
    selected = parsed.resources.find(r => r.type.toLowerCase() === options.type.toLowerCase());
  }

  if (!selected) {
    const videos = parsed.resources.filter(r => r.type === 'video');
    selected = videos.length > 0 ? videos[videos.length - 1] : parsed.resources[0];
  }

  const resolved = await resolveDownloadUrl(selected.resource_content, options);

  return {
    status: true,
    id: parsed.id,
    title: parsed.title,
    thumbnail: parsed.thumbnail,
    duration: parsed.duration,
    selected: {
      quality: selected.quality,
      format: selected.format,
      type: selected.type,
      size: selected.size,
      download_link: resolved.download_link,
      direct_url: resolved.direct_url
    },
    resources: parsed.resources
  };
}

export default {
  parse,
  resolveDownloadUrl,
  download
};
