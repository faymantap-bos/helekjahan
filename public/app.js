const form = document.querySelector('#downloadForm');
const input = document.querySelector('#videoUrl');
const pasteButton = document.querySelector('#pasteButton');
const submitButton = document.querySelector('#submitButton');
const resultSection = document.querySelector('#resultSection');
const statusCard = document.querySelector('#statusCard');
const statusTitle = document.querySelector('#statusTitle');
const statusText = document.querySelector('#statusText');
const mediaCard = document.querySelector('#mediaCard');
const thumbnail = document.querySelector('#thumbnail');
const sourceBadge = document.querySelector('#sourceBadge');
const mediaTitle = document.querySelector('#mediaTitle');
const mediaMeta = document.querySelector('#mediaMeta');
const resourceList = document.querySelector('#resourceList');
const filterRow = document.querySelector('#filterRow');
const toast = document.querySelector('#toast');

let resources = [];
let currentFilter = 'all';

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3500);
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!value) return '';
  const minutes = Math.floor(value / 60);
  const rest = Math.floor(value % 60).toString().padStart(2, '0');
  return `${minutes}:${rest}`;
}

function formatSize(size) {
  if (!size) return 'Ukuran tidak diketahui';
  if (typeof size === 'string') return size;
  const bytes = Number(size);
  if (!Number.isFinite(bytes)) return 'Ukuran tidak diketahui';
  const units = ['B', 'KB', 'MB', 'GB'];
  let unit = 0;
  let value = bytes;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.status === false) throw new Error(data.error || 'Permintaan gagal');
  return data;
}

function showStatus(title, text, error = false) {
  resultSection.hidden = false;
  statusCard.hidden = false;
  mediaCard.hidden = true;
  statusCard.classList.toggle('error', error);
  statusTitle.textContent = title;
  statusText.textContent = text;
}

function getResourceType(resource) {
  const type = String(resource.type || '').toLowerCase();
  return type.includes('audio') || ['mp3', 'm4a', 'aac', 'opus'].includes(String(resource.format).toLowerCase()) ? 'audio' : 'video';
}

function renderResources() {
  resourceList.replaceChildren();
  const visible = resources.filter(item => currentFilter === 'all' || getResourceType(item) === currentFilter);
  if (visible.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = `Format ${currentFilter === 'audio' ? 'audio' : 'video'} tidak tersedia.`;
    resourceList.append(empty);
    return;
  }

  visible.forEach(resource => {
    const type = getResourceType(resource);
    const row = document.createElement('div');
    row.className = 'resource';

    const info = document.createElement('div');
    info.className = 'resource-info';
    const icon = document.createElement('span');
    icon.className = 'type-icon';
    icon.textContent = type === 'audio' ? '♪' : '▶';
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${resource.quality || 'Auto'} · ${String(resource.format || type).toUpperCase()}`;
    const meta = document.createElement('small');
    meta.textContent = `${type === 'audio' ? 'Audio' : 'Video'} · ${formatSize(resource.size)}`;
    copy.append(title, meta);
    info.append(icon, copy);

    const button = document.createElement('button');
    button.className = 'download-button';
    button.type = 'button';
    button.textContent = 'Unduh ↓';
    button.addEventListener('click', () => downloadResource(resource, button));
    row.append(info, button);
    resourceList.append(row);
  });
}

async function downloadResource(resource, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Menyiapkan...';
  try {
    const data = await api('/api/resolve', { token: resource.token });
    const link = document.createElement('a');
    link.href = data.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.append(link);
    link.click();
    link.remove();
    showToast('Unduhan dibuka di tab baru.');
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function showResult(data) {
  resources = data.resources || [];
  currentFilter = 'all';
  filterRow.querySelectorAll('.filter').forEach(button => button.classList.toggle('active', button.dataset.filter === 'all'));
  statusCard.hidden = true;
  mediaCard.hidden = false;
  sourceBadge.textContent = data.platform || 'Media';
  mediaTitle.textContent = data.title || 'Media tanpa judul';
  const details = [`${resources.length} format`];
  const duration = formatDuration(data.duration);
  if (duration) details.push(duration);
  mediaMeta.textContent = details.join(' · ');
  if (data.thumbnail) {
    thumbnail.src = data.thumbnail;
    thumbnail.hidden = false;
  } else {
    thumbnail.removeAttribute('src');
    thumbnail.hidden = true;
  }
  renderResources();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) return input.focus();
  submitButton.disabled = true;
  showStatus('Menganalisis tautan', 'Sedang mencari format yang tersedia...');
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
  try {
    const data = await api('/api/analyze', { url });
    if (!data.resources?.length) throw new Error('Tidak ada format unduhan yang ditemukan untuk tautan ini.');
    showResult(data);
  } catch (error) {
    showStatus('Tautan belum bisa diproses', error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});

pasteButton.addEventListener('click', async () => {
  try {
    input.value = await navigator.clipboard.readText();
    input.focus();
  } catch {
    showToast('Izin clipboard tidak tersedia. Tempel tautan secara manual.');
    input.focus();
  }
});

filterRow.addEventListener('click', event => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  currentFilter = button.dataset.filter;
  filterRow.querySelectorAll('.filter').forEach(item => item.classList.toggle('active', item === button));
  renderResources();
});
