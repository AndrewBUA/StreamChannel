const newChannelName = document.getElementById('new-channel-name');
const addChannelBtn = document.getElementById('add-channel-btn');
const channelsList = document.getElementById('channels-list');
const channelSelect = document.getElementById('channel-select');
const addShowBtn = document.getElementById('add-show-btn');
const batchUrlsInput = document.getElementById('batch-urls-input');
const addBatchBtn = document.getElementById('add-batch-btn');
const ccDefaultEnabledInput = document.getElementById('cc-default-enabled');
const maximizePlayerEnabledInput = document.getElementById('maximize-player-enabled');
const ccLanguageSelect = document.getElementById('cc-language-select');
const currentShowTitle = document.getElementById('current-show-title');
const currentShowMeta = document.getElementById('current-show-meta');
const playbackStatus = document.getElementById('playback-status');
const backBtn = document.getElementById('back-btn');
const stopBtn = document.getElementById('stop-btn');
const skipBtn = document.getElementById('skip-btn');
const exportDataBtn = document.getElementById('export-data-btn');
const importDataBtn = document.getElementById('import-data-btn');
const importDataFileInput = document.getElementById('import-data-file');

let currentItem = {
  title: '',
  platform: '',
  pageType: 'unknown',
  seriesUrl: '',
  episodeUrl: '',
  sourceUrl: ''
};

let playbackState = { running: false, channelName: '', canGoBack: false };
let appSettings = { captionsEnabledDefault: false, captionsLanguage: 'en', maximizePlayer: false };
const expandedChannels = new Set();
let expansionInitialized = false;
let dragChannelName = '';
let dragItemId = '';
let cachedChannels = {};
const ALLOWED_STREAM_ORIGINS = new Set([
  'https://www.netflix.com',
  'https://www.hulu.com',
  'https://play.hbomax.com'
]);

function getStorageChannels() {
  return new Promise((resolve) => chrome.storage.sync.get('channels', (data) => resolve(data.channels || {})));
}

function setStorageChannels(channels) {
  return new Promise((resolve) => chrome.storage.sync.set({ channels }, resolve));
}

function defaultSettings() {
  return {
    captionsEnabledDefault: false,
    captionsLanguage: 'en',
    maximizePlayer: false
  };
}

function defaultChannelProfile() {
  return {
    ccEnabledDefault: null,
    captionsLanguage: '',
    maximizePlayer: null
  };
}

function normalizeChannelProfile(rawProfile) {
  if (!rawProfile || typeof rawProfile !== 'object') return null;
  const base = { ...defaultChannelProfile(), ...(rawProfile || {}) };
  return {
    ccEnabledDefault: typeof base.ccEnabledDefault === 'boolean' ? base.ccEnabledDefault : null,
    captionsLanguage: String(base.captionsLanguage || ''),
    maximizePlayer: typeof base.maximizePlayer === 'boolean' ? base.maximizePlayer : null
  };
}

function channelProfileFromAppSettings() {
  return {
    ccEnabledDefault: Boolean(appSettings.captionsEnabledDefault),
    captionsLanguage: String(appSettings.captionsLanguage || 'en'),
    maximizePlayer: Boolean(appSettings.maximizePlayer)
  };
}

function normalizeSettings(rawSettings) {
  const base = { ...defaultSettings(), ...(rawSettings || {}) };
  return {
    captionsEnabledDefault: Boolean(base.captionsEnabledDefault),
    captionsLanguage: String(base.captionsLanguage || 'en'),
    maximizePlayer: Boolean(base.maximizePlayer)
  };
}

function getStorageSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get('streamSettings', (data) => {
      resolve(normalizeSettings(data.streamSettings));
    });
  });
}

function setStorageSettings(settings) {
  return new Promise((resolve) => chrome.storage.sync.set({ streamSettings: settings }, resolve));
}

function normalizeChannels(rawChannels) {
  const normalized = {};
  Object.entries(rawChannels).forEach(([name, value]) => {
    if (Array.isArray(value)) {
      normalized[name] = {
        createdAt: Date.now(),
        shuffleMode: 'sequential',
        lastPlayedItemId: '',
        profile: null,
        items: value.map((legacy) => sanitizeChannelItem({
          id: `legacy-${Math.random().toString(36).slice(2, 10)}`,
          title: legacy.title || 'Untitled',
          platform: detectPlatform(legacy.url || legacy.seriesUrl || ''),
          type: 'episode',
          seriesUrl: legacy.seriesUrl || legacy.url || '',
          episodeUrl: '',
          sourceUrl: legacy.url || legacy.seriesUrl || '',
          ccEnabled: false,
          addedAt: Date.now(),
          playCount: 0,
          lastPlayedAt: 0,
          maxPlays: 0,
          cooldownMinutes: 0
        })).filter(Boolean)
      };
      return;
    }

    normalized[name] = {
      createdAt: value.createdAt || Date.now(),
      shuffleMode: String(value.shuffleMode || 'sequential'),
      lastPlayedItemId: String(value.lastPlayedItemId || ''),
      profile: value.profile ? normalizeChannelProfile(value.profile) : null,
      items: Array.isArray(value.items)
        ? value.items.map((item) => sanitizeChannelItem({
            ...item,
            ccEnabled: Boolean(item?.ccEnabled),
            maxPlays: Math.max(0, Number(item?.maxPlays || 0) || 0),
            cooldownMinutes: Math.max(0, Number(item?.cooldownMinutes || 0) || 0)
          })).filter(Boolean)
        : []
    };
    if (normalized[name].lastPlayedItemId &&
      !normalized[name].items.some((item) =>
        String(item?.id || '') === String(normalized[name].lastPlayedItemId || '')
      )) {
      normalized[name].lastPlayedItemId = '';
    }
  });
  return normalized;
}

function parseUrlSafe(rawUrl) {
  try {
    return new URL(String(rawUrl || ''));
  } catch (_) {
    return null;
  }
}

function sanitizeStreamUrl(rawUrl) {
  if (!rawUrl) return '';
  const parsed = parseUrlSafe(rawUrl);
  if (!parsed) return '';
  if (parsed.protocol !== 'https:') return '';

  const host = parsed.hostname.toLowerCase();
  let origin = '';
  if (host === 'www.netflix.com' || host.endsWith('.netflix.com')) {
    origin = 'https://www.netflix.com';
  } else if (host === 'www.hulu.com' || host.endsWith('.hulu.com')) {
    origin = 'https://www.hulu.com';
  } else if (
    host === 'play.hbomax.com' ||
    host === 'play.max.com' ||
    host.endsWith('.hbomax.com') ||
    host.endsWith('.max.com')
  ) {
    origin = 'https://play.hbomax.com';
  } else {
    return '';
  }

  if (!ALLOWED_STREAM_ORIGINS.has(origin)) return '';
  const pathname = parsed.pathname || '/';
  const search = parsed.search || '';
  return `${origin}${pathname}${search}`;
}

function sanitizeChannelItem(item) {
  if (!item) return null;
  const seriesUrl = sanitizeStreamUrl(item.seriesUrl || '');
  const episodeUrl = sanitizeStreamUrl(item.episodeUrl || '');
  const sourceUrl = sanitizeStreamUrl(item.sourceUrl || '');
  const fallbackUrl = seriesUrl || episodeUrl || sourceUrl;
  if (!fallbackUrl) return null;
  return {
    ...item,
    type: 'episode',
    platform: detectPlatform(fallbackUrl),
    seriesUrl,
    episodeUrl,
    sourceUrl
  };
}

function detectPlatform(url) {
  if (!url) return 'unknown';
  const parsed = parseUrlSafe(url);
  if (!parsed) return 'unknown';
  const host = parsed.hostname.toLowerCase();
  if (host === 'www.netflix.com') return 'netflix';
  if (host === 'www.hulu.com') return 'hulu';
  if (host === 'play.hbomax.com') return 'max';
  return 'unknown';
}

function getPreferredUrl(item, typeOverride) {
  const seriesUrl = sanitizeStreamUrl(item.seriesUrl || '');
  const episodeUrl = sanitizeStreamUrl(item.episodeUrl || '');
  const sourceUrl = sanitizeStreamUrl(item.sourceUrl || '');
  return episodeUrl || sourceUrl || seriesUrl || '';
}

function getDisplayType(item) {
  return 'episode';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildItemFromCurrent() {
  const seriesUrl = sanitizeStreamUrl(currentItem.seriesUrl || '');
  const episodeUrl = sanitizeStreamUrl(currentItem.episodeUrl || '');
  const sourceUrl = sanitizeStreamUrl(currentItem.sourceUrl || '');
  const urlForType = episodeUrl || sourceUrl || seriesUrl;

  if (!urlForType) return null;
  const selectedChannel = channelSelect.value;
  const channelProfile = normalizeChannelProfile(cachedChannels[selectedChannel]?.profile) || channelProfileFromAppSettings();

  return {
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: currentItem.title || 'Untitled',
    platform: currentItem.platform || detectPlatform(urlForType),
    type: 'episode',
    seriesUrl,
    episodeUrl,
    sourceUrl: sourceUrl || urlForType,
    ccEnabled: typeof channelProfile?.ccEnabledDefault === 'boolean'
      ? channelProfile.ccEnabledDefault
      : Boolean(appSettings.captionsEnabledDefault),
    addedAt: Date.now(),
    playCount: 0,
    lastPlayedAt: 0,
    maxPlays: 0,
    cooldownMinutes: 0
  };
}

function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function clearDragMarkers() {
  const rows = channelsList.querySelectorAll('.item-row');
  rows.forEach((row) => {
    row.classList.remove('dragging', 'drop-before', 'drop-after');
  });
}

async function reorderChannelItems(channelName, fromItemId, toItemId, insertAfter = false) {
  if (!channelName || !fromItemId || !toItemId || fromItemId === toItemId) return;
  const channels = normalizeChannels(await getStorageChannels());
  const channel = channels[channelName];
  if (!channel || !Array.isArray(channel.items) || channel.items.length < 2) return;

  const fromIndex = channel.items.findIndex((item) => item.id === fromItemId);
  const toIndex = channel.items.findIndex((item) => item.id === toItemId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

  const [moved] = channel.items.splice(fromIndex, 1);
  if (!moved) return;
  let insertIndex = insertAfter ? toIndex + 1 : toIndex;
  if (fromIndex < insertIndex) insertIndex -= 1;
  channel.items.splice(insertIndex, 0, moved);

  await setStorageChannels(channels);
}

function getItemIdentityKey(item) {
  return `${String(item.platform || 'unknown')}|${getPreferredUrl(item)}`;
}

function dedupeChannelItems(channel) {
  const items = Array.isArray(channel?.items) ? channel.items : [];
  if (items.length < 2) return 0;
  const keep = [];
  const byKey = new Map();
  let removed = 0;

  items.forEach((item) => {
    const key = getItemIdentityKey(item);
    if (!byKey.has(key)) {
      byKey.set(key, item);
      keep.push(item);
      return;
    }
    const existing = byKey.get(key);
    existing.playCount = Math.max(0, Number(existing.playCount || 0) || 0) +
      Math.max(0, Number(item.playCount || 0) || 0);
    existing.lastPlayedAt = Math.max(
      Math.max(0, Number(existing.lastPlayedAt || 0) || 0),
      Math.max(0, Number(item.lastPlayedAt || 0) || 0)
    );
    existing.ccEnabled = Boolean(existing.ccEnabled || item.ccEnabled);
    existing.maxPlays = Math.max(
      Math.max(0, Number(existing.maxPlays || 0) || 0),
      Math.max(0, Number(item.maxPlays || 0) || 0)
    );
    existing.cooldownMinutes = Math.max(
      Math.max(0, Number(existing.cooldownMinutes || 0) || 0),
      Math.max(0, Number(item.cooldownMinutes || 0) || 0)
    );
    removed += 1;
  });

  channel.items = keep;
  return removed;
}

function parseNonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function buildBatchItemFromUrl(rawUrl, channelName = '') {
  const safeUrl = sanitizeStreamUrl(rawUrl);
  if (!safeUrl) return null;
  const parsed = parseUrlSafe(safeUrl);
  if (!parsed) return null;
  const platform = detectPlatform(safeUrl);
  const path = String(parsed.pathname || '/').replace(/\/+/g, '/');
  const leaf = path.split('/').filter(Boolean).pop() || 'item';
  const hostLabel = platform === 'netflix' ? 'Netflix' : platform === 'hulu' ? 'Hulu' : 'HBO Max';
  const channelProfile = normalizeChannelProfile(cachedChannels[channelName]?.profile) || channelProfileFromAppSettings();
  const item = {
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: `${hostLabel} ${leaf}`,
    platform,
    type: 'episode',
    seriesUrl: '',
    episodeUrl: '',
    sourceUrl: safeUrl,
    ccEnabled: typeof channelProfile.ccEnabledDefault === 'boolean'
      ? channelProfile.ccEnabledDefault
      : Boolean(appSettings.captionsEnabledDefault),
    addedAt: Date.now(),
    playCount: 0,
    lastPlayedAt: 0,
    maxPlays: 0,
    cooldownMinutes: 0
  };
  if (platform === 'netflix') {
    if (/\/watch\/\d+/i.test(path)) item.episodeUrl = safeUrl;
    if (/\/title\/\d+/i.test(path)) item.seriesUrl = safeUrl;
  } else if (platform === 'hulu') {
    if (/\/watch\//i.test(path)) item.episodeUrl = safeUrl;
    if (/\/series\//i.test(path)) item.seriesUrl = safeUrl;
  } else if (platform === 'max') {
    if (/\/video\/watch\//i.test(path) || /\/watch\//i.test(path)) item.episodeUrl = safeUrl;
    if (/\/series\//i.test(path) || /\/show\//i.test(path)) item.seriesUrl = safeUrl;
  }
  return sanitizeChannelItem(item);
}

function channelToCard(name, channel) {
  const items = channel.items || [];
  const isActive = playbackState.running && playbackState.channelName === name;
  const expanded = expandedChannels.has(name);
  const shuffleMode = String(channel.shuffleMode || 'sequential');
  const rememberedId = String(channel.lastPlayedItemId || '');
  const profile = normalizeChannelProfile(channel.profile) || channelProfileFromAppSettings();

  const encodedName = encodeURIComponent(name);
  const selectedStartItemId = rememberedId && items.some((item) => String(item.id || '') === rememberedId)
    ? rememberedId
    : String(items[0]?.id || '');
  const startOptions = items.map((item, index) => (
    `<option value="${String(item.id || '')}" ${(rememberedId ? String(item.id || '') === rememberedId : index === 0) ? 'selected' : ''}>${escapeHtml(item.title || 'Untitled')}</option>`
  )).join('');

  const itemsHtml = items.length === 0
    ? '<p class="empty">No shows or episodes yet.</p>'
    : `<div class="start-row">
        <select class="start-item-select" data-channel="${encodedName}">${startOptions}</select>
        <button class="btn btn-primary start-item-btn" data-channel="${encodedName}" data-start-item-id="${escapeHtml(selectedStartItemId)}">Start Here</button>
      </div>
      <ul class="items">${items.map((item) => {
        const shortUrl = getPreferredUrl(item).replace(/^https?:\/\//, '').slice(0, 58);
        return `
          <li class="item-row" draggable="true" data-channel="${encodedName}" data-item-id="${item.id}">
            <h4>
              <span class="drag-handle" title="Drag to reorder">::</span>
              ${escapeHtml(item.title || 'Untitled')}
              <span class="badge">${escapeHtml(item.platform || 'unknown')}</span>
            </h4>
            <p>${escapeHtml(shortUrl || 'No URL')}</p>
            <div class="item-actions">
              <button class="btn btn-ghost open-item-btn" data-channel="${encodedName}" data-item-id="${item.id}">Open</button>
              <button class="btn btn-ghost toggle-cc-btn ${item.ccEnabled ? 'cc-on' : 'cc-off'}" data-channel="${encodedName}" data-item-id="${item.id}">
                CC ${item.ccEnabled ? 'On' : 'Off'}
              </button>
              <button class="btn btn-ghost repair-item-btn" data-channel="${encodedName}" data-item-id="${item.id}">
                Fix URL
              </button>
              <button class="btn btn-danger remove-item-btn" data-channel="${encodedName}" data-item-id="${item.id}">Remove</button>
            </div>
            <div class="item-tuning">
              <label>
                Play Count
                <span class="playcount-controls">
                  <button class="btn btn-ghost item-playcount-dec-btn" data-channel="${encodedName}" data-item-id="${item.id}" title="Decrease play count">-</button>
                  <strong class="playcount-value">${Math.max(0, Number(item.playCount || 0) || 0)}</strong>
                  <button class="btn btn-ghost item-playcount-inc-btn" data-channel="${encodedName}" data-item-id="${item.id}" title="Increase play count">+</button>
                  <button class="btn btn-ghost item-playcount-reset-btn" data-channel="${encodedName}" data-item-id="${item.id}" title="Reset play count">Reset</button>
                </span>
              </label>
              <label>
                Max Plays
                <input type="number" min="0" step="1" class="item-max-plays-input" data-channel="${encodedName}" data-item-id="${item.id}" value="${Math.max(0, Number(item.maxPlays || 0) || 0)}">
              </label>
              <label>
                Cooldown (min)
                <input type="number" min="0" step="1" class="item-cooldown-input" data-channel="${encodedName}" data-item-id="${item.id}" value="${Math.max(0, Number(item.cooldownMinutes || 0) || 0)}">
              </label>
            </div>
          </li>
        `;
      }).join('')}</ul>`;

  return `
    <li class="channel-card ${isActive ? 'active' : ''}">
      <div class="channel-head">
        <button class="toggle-channel-btn" data-channel="${encodedName}" title="Expand or collapse">${expanded ? '-' : '+'}</button>
        <div class="channel-meta">
          <strong>${escapeHtml(name)}</strong>
          <span>${items.length} item(s) ${isActive ? '- LIVE' : ''}</span>
        </div>
        <div class="channel-controls">
          <button class="btn btn-primary play-channel-btn" data-channel="${encodedName}">Play</button>
          <button class="btn btn-ghost stop-channel-btn">Stop</button>
          <button class="btn btn-ghost randomize-channel-btn" data-channel="${encodedName}" ${items.length < 2 ? 'disabled' : ''}>Randomize</button>
          <button class="btn btn-ghost clone-channel-btn" data-channel="${encodedName}">Clone</button>
          <select class="shuffle-mode-select" data-channel="${encodedName}" title="Auto-next mode">
            <option value="sequential" ${shuffleMode === 'sequential' ? 'selected' : ''}>Sequential</option>
            <option value="random" ${shuffleMode === 'random' ? 'selected' : ''}>True Random</option>
            <option value="least_played" ${shuffleMode === 'least_played' ? 'selected' : ''}>Least Played</option>
            <option value="newest" ${shuffleMode === 'newest' ? 'selected' : ''}>Newest First</option>
          </select>
          <button class="btn btn-ghost dedupe-channel-btn" data-channel="${encodedName}" ${items.length < 2 ? 'disabled' : ''}>Dedup</button>
          <button class="btn btn-danger delete-channel-btn" data-channel="${encodedName}">Delete</button>
        </div>
      </div>
      <div class="channel-body ${expanded ? '' : 'collapsed'}">
        <div class="channel-profile">
          <label>
            <input type="checkbox" class="channel-cc-default-input" data-channel="${encodedName}" ${profile.ccEnabledDefault ? 'checked' : ''}>
            CC Default
          </label>
          <label>
            <input type="checkbox" class="channel-max-default-input" data-channel="${encodedName}" ${profile.maximizePlayer ? 'checked' : ''}>
            Max Default
          </label>
          <select class="channel-cc-language-select" data-channel="${encodedName}">
            <option value="en" ${profile.captionsLanguage === 'en' ? 'selected' : ''}>English</option>
            <option value="en-US" ${profile.captionsLanguage === 'en-US' ? 'selected' : ''}>English (US)</option>
            <option value="en-GB" ${profile.captionsLanguage === 'en-GB' ? 'selected' : ''}>English (UK)</option>
          </select>
        </div>
        ${itemsHtml}
      </div>
    </li>
  `;
}

async function refreshPlaybackState() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getPlaybackState' }, (state) => {
      playbackState = state || { running: false, channelName: '', canGoBack: false };
      if (!playbackState.running) {
        playbackStatus.textContent = 'Idle';
        backBtn.disabled = true;
        stopBtn.disabled = true;
        skipBtn.disabled = true;
      } else {
        playbackStatus.textContent = `Playing ${playbackState.channelName}`;
        backBtn.disabled = !playbackState.canGoBack;
        stopBtn.disabled = false;
        skipBtn.disabled = false;
      }
      resolve();
    });
  });
}

async function loadChannels() {
  const stored = await getStorageChannels();
  const channels = normalizeChannels(stored);
  await setStorageChannels(channels);
  cachedChannels = channels;

  const names = Object.keys(channels);
  channelSelect.innerHTML = '';

  if (names.length === 0) {
    channelsList.innerHTML = '<p class="empty">No channels yet. Create one to start building your lineup.</p>';
    addShowBtn.disabled = true;
    return;
  }

  addShowBtn.disabled = false;
  names.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    channelSelect.appendChild(option);
  });

  if (!expansionInitialized) {
    expandedChannels.add(playbackState.channelName || names[0]);
    expansionInitialized = true;
  }

  channelsList.innerHTML = names.map((name) => channelToCard(name, channels[name])).join('');
}

async function loadSettings() {
  appSettings = await getStorageSettings();
  ccDefaultEnabledInput.checked = appSettings.captionsEnabledDefault;
  maximizePlayerEnabledInput.checked = appSettings.maximizePlayer;
  ccLanguageSelect.value = appSettings.captionsLanguage;
}

function setCurrentItemUi() {
  const title = currentItem.title || 'Could not detect show/episode on this page';
  currentShowTitle.textContent = title;
  currentShowMeta.textContent = `${currentItem.platform || 'unknown'} - detected as ${currentItem.pageType}`;

  const usableUrl = currentItem.pageType === 'episode'
    ? (currentItem.episodeUrl || currentItem.sourceUrl)
    : (currentItem.seriesUrl || currentItem.sourceUrl);
  addShowBtn.disabled = !usableUrl;
}

async function getPageInfo() {
  try {
  function normalizeTitle(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isGenericTitle(value) {
    const clean = normalizeTitle(value).toLowerCase();
    return !clean ||
      clean === 'hulu' ||
      clean === 'hulu home' ||
      clean === 'hulu | home' ||
      clean === 'hulu | series' ||
      clean === 'netflix' ||
      clean === 'home - netflix' ||
      clean === 'new & popular - netflix' ||
      clean === 'new and popular - netflix' ||
      clean === 'my list - netflix' ||
      clean.startsWith('hulu |') ||
      clean.startsWith('netflix |');
  }

  function getNetflixSeriesIdFromUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const tctx = decodeURIComponent(parsed.searchParams.get('tctx') || '');
      const videoMatch = tctx.match(/Video:(\d+)/i);
      return videoMatch?.[1] || '';
    } catch (_) {
      return '';
    }
  }

  function getNetflixSeriesIdFromJbv(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const jbv = parsed.searchParams.get('jbv') || '';
      return /^\d+$/.test(jbv) ? jbv : '';
    } catch (_) {
      return '';
    }
  }

  function getNetflixIdFromPath(rawUrl, segment) {
    const match = rawUrl.match(new RegExp(`\\/${segment}\\/(\\d+)`, 'i'));
    return match?.[1] || '';
  }

  function getNetflixSeriesIdFromReactContext() {
    const originalUrl = String(
      window?.netflix?.reactContext?.models?.serverDefs?.data?.originalUrl || ''
    );
    return getNetflixIdFromPath(originalUrl, 'title');
  }

  function getNetflixSeriesIdFromFalcorWatch(watchId) {
    if (!watchId) return '';
    const videos = window?.netflix?.falcorCache?.videos || {};
    const watchEntry = videos?.[watchId] || {};
    const ancestorRef = watchEntry?.ancestor?.value;
    if (Array.isArray(ancestorRef) && ancestorRef[0] === 'videos' && ancestorRef[1]) {
      return String(ancestorRef[1]);
    }
    const summary = watchEntry?.summary?.value || {};
    if (summary.type === 'show' && summary.id) return String(summary.id);
    if (summary.parentId) return String(summary.parentId);
    return '';
  }

  function getNetflixTitleById(videoId) {
    if (!videoId) return '';
    const entry = window?.netflix?.falcorCache?.videos?.[videoId] || {};
    const candidates = [
      entry?.title?.value,
      entry?.jawSummary?.value?.title,
      entry?.bobSummary?.value?.title,
      entry?.itemSummary?.value?.title,
      entry?.summary?.value?.title
    ];
    for (const candidate of candidates) {
      const clean = normalizeTitle(candidate);
      if (clean && !isGenericTitle(clean)) return clean;
    }

    function decodeEscapedNetflixText(value) {
      return String(value || '')
        .replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\"/g, '"')
        .replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }

    // Isolated-world scripts can miss page globals; parse inline JSON as fallback.
    try {
      const scripts = Array.from(document.querySelectorAll('script'));
      const marker = `"${videoId}":{`;
      for (const script of scripts) {
        const text = script?.textContent || '';
        if (!text || !text.includes('netflix.falcorCache') || !text.includes(marker)) continue;

        const escapedId = String(videoId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const blockMatch = text.match(new RegExp(`"${escapedId}":\\{([\\s\\S]*?)\\},"\\d+":\\{`));
        const block = blockMatch?.[1] || '';
        if (!block) continue;

        const titleMatch =
          block.match(/"title"\s*:\s*\{\s*"\\x24type"\s*:\s*"atom"\s*,\s*"value"\s*:\s*"([^"]+)"/) ||
          block.match(/"itemSummary"\s*:\s*\{\s*"\\x24type"\s*:\s*"atom"\s*,\s*"value"\s*:\s*\{[\s\S]{0,8000}?"title"\s*:\s*"([^"]+)"/) ||
          block.match(/"bobSummary"\s*:\s*\{\s*"\\x24type"\s*:\s*"atom"\s*,\s*"value"\s*:\s*\{[\s\S]{0,8000}?"title"\s*:\s*"([^"]+)"/) ||
          block.match(/"jawSummary"\s*:\s*\{\s*"\\x24type"\s*:\s*"atom"\s*,\s*"value"\s*:\s*\{[\s\S]{0,8000}?"title"\s*:\s*"([^"]+)"/);
        if (!titleMatch?.[1]) continue;

        const clean = normalizeTitle(decodeEscapedNetflixText(titleMatch[1]));
        if (clean && !isGenericTitle(clean)) return clean;
      }
    } catch (_) {}

    return '';
  }

  function getNetflixTitle(url) {
    try {
      const titleIdFromPath = getNetflixIdFromPath(url, 'title');
      const jbvIdFromUrl = getNetflixSeriesIdFromJbv(url);
      const watchId = getNetflixIdFromPath(url, 'watch');
      const seriesIdFromTctx = getNetflixSeriesIdFromUrl(url);
      const seriesIdFromContext = getNetflixSeriesIdFromReactContext();
      const seriesIdFromWatch = watchId ? getNetflixSeriesIdFromFalcorWatch(watchId) : '';
      const candidateIds = [
        titleIdFromPath,
        jbvIdFromUrl,
        seriesIdFromWatch,
        seriesIdFromTctx,
        seriesIdFromContext
      ].filter(Boolean);

      for (const id of candidateIds) {
        const byIdTitle = getNetflixTitleById(id);
        if (byIdTitle) return byIdTitle;
      }

      if (watchId) {
        const seriesId = getNetflixSeriesIdFromFalcorWatch(watchId) ||
          seriesIdFromTctx ||
          seriesIdFromContext;
        const fromWatch = getNetflixTitleById(seriesId);
        if (fromWatch) return fromWatch;
      }

      const selector = [
        '[data-uia="video-title"]',
        '[data-uia="watch-video-title"]',
        '.video-title h1',
        '.video-title h4',
        '.title-title',
        '.fallback-text'
      ].join(', ');

      const fromDom = normalizeTitle(document.querySelector(selector)?.textContent);
      if (fromDom && !isGenericTitle(fromDom)) return fromDom;

      const ogTitle = normalizeTitle(document.querySelector('meta[property="og:title"]')?.content);
      if (ogTitle && !isGenericTitle(ogTitle)) return ogTitle;

      const reactTitle = normalizeTitle(window?.netflix?.reactContext?.models?.pageProperties?.data?.title);
      if (reactTitle && !isGenericTitle(reactTitle)) return reactTitle;

      return '';
    } catch (_) {
      return '';
    }
  }

  function pickTitleFromDom(url, host) {
    if (host.includes('netflix.com')) {
      const netflixTitle = getNetflixTitle(url);
      if (netflixTitle) return netflixTitle;
    }

    const selector = [
      'h1[data-testid*="title"]',
      '[data-testid*="title"] h1',
      '.detail-title',
      '.masthead-title-container .title',
      '.PlayerMetadata__title',
      '.TitleView__TitleText',
      '.title-title',
      'h1'
    ].join(', ');

    const domTitle = normalizeTitle(document.querySelector(selector)?.textContent);
    if (domTitle) return domTitle;

    const metaTitle = normalizeTitle(
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('meta[name="twitter:title"]')?.content
    );
    if (metaTitle) return metaTitle;

    return normalizeTitle(document.title.split(' - ')[0].split(' | ')[0]);
  }

  async function waitForInformativeTitle(url, host, timeoutMs = 4500) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const title = pickTitleFromDom(url, host);
      if (!isGenericTitle(title)) return title;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return pickTitleFromDom(url, host);
  }

  const url = window.location.href;
  const host = window.location.hostname.toLowerCase();
  const titleFromDom = await waitForInformativeTitle(url, host);

  let platform = 'unknown';
  let pageType = 'unknown';
  let seriesUrl = '';
  let episodeUrl = '';

  if (host.includes('netflix.com')) {
    platform = 'netflix';
    const watchMatch = url.match(/https:\/\/www\.netflix\.com\/watch\/\d+/i);
    const titleMatch = url.match(/https:\/\/www\.netflix\.com\/title\/\d+/i);
    const seriesIdFromTctx = getNetflixSeriesIdFromUrl(url);
    const seriesIdFromJbv = getNetflixSeriesIdFromJbv(url);
    const seriesIdFromContext = getNetflixSeriesIdFromReactContext();
    pageType = 'show';

    let canonicalSeriesId = '';
    if (titleMatch) {
      canonicalSeriesId = titleMatch[0].split('/').pop() || '';
    } else if (seriesIdFromJbv) {
      canonicalSeriesId = seriesIdFromJbv;
    } else if (watchMatch) {
      const watchId = watchMatch[0].split('/').pop() || '';
      canonicalSeriesId = getNetflixSeriesIdFromFalcorWatch(watchId) || '';
    }
    if (!canonicalSeriesId) canonicalSeriesId = seriesIdFromTctx || seriesIdFromContext;

    if (canonicalSeriesId) {
      seriesUrl = `https://www.netflix.com/title/${canonicalSeriesId}`;
      // Only keep a watch URL when we are actually on a concrete /watch/{videoId} page.
      if (watchMatch) {
        const watchId = watchMatch[0].split('/').pop() || '';
        episodeUrl = watchId ? `https://www.netflix.com/watch/${watchId}` : '';
      }
    } else {
      const seriesAnchor = document.querySelector('a[href*="/title/"]')?.href || '';
      const seriesMatch = seriesAnchor.match(/https:\/\/www\.netflix\.com\/title\/\d+/i);
      seriesUrl = seriesMatch ? seriesMatch[0] : '';
      if (!seriesUrl && watchMatch) {
        const watchId = watchMatch[0].split('/').pop() || '';
        if (watchId) {
          episodeUrl = `https://www.netflix.com/watch/${watchId}`;
        }
      }
    }
  } else if (host.includes('hulu.com')) {
    platform = 'hulu';
    const showMatch = url.match(/https:\/\/www\.hulu\.com\/series\/[a-z0-9-]+/i);
    const episodeMatch = url.match(/https:\/\/www\.hulu\.com\/watch\/[a-z0-9-]+/i);
    if (episodeMatch) {
      pageType = 'episode';
      episodeUrl = episodeMatch[0];
      seriesUrl = document.querySelector('a[href*="/series/"]')?.href || '';
    } else if (showMatch) {
      pageType = 'show';
      seriesUrl = showMatch[0];
    }
  } else if (host.includes('max.com') || host.includes('hbomax.com')) {
    platform = 'max';
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch (_) {}

    const path = parsed?.pathname || '';
    const isEpisodePath = /\/video\/watch\/[^?#]+/i.test(path) || /\/watch\/[^?#]+/i.test(path);
    const isShowPath = /\/(show|series)\/[^/?#]+/i.test(path);
    const origin = parsed?.origin || 'https://play.hbomax.com';

    if (isEpisodePath) {
      pageType = 'episode';
      const watchPathMatch = path.match(/\/(video\/watch\/[^?#]+|watch\/[^?#]+)/i);
      if (watchPathMatch?.[1]) {
        episodeUrl = `${origin}/${watchPathMatch[1]}`;
      } else {
        episodeUrl = url;
      }

      const seriesAnchor = document.querySelector('a[href*="/show/"], a[href*="/series/"]')?.getAttribute('href') || '';
      if (seriesAnchor) {
        try {
          seriesUrl = new URL(seriesAnchor, origin).toString();
        } catch (_) {
          seriesUrl = seriesAnchor;
        }
      }
    } else if (isShowPath) {
      pageType = 'show';
      const showMatch = path.match(/\/(show|series)\/[^/?#]+/i);
      if (showMatch?.[0]) {
        seriesUrl = `${origin}${showMatch[0]}`;
      } else {
        seriesUrl = url;
      }
    }
  }

  return {
    title: titleFromDom || (host.includes('netflix.com') ? `Netflix Item` : 'Untitled'),
    platform,
    pageType,
    seriesUrl: seriesUrl || '',
    episodeUrl: episodeUrl || '',
    sourceUrl: host.includes('netflix.com') ? url : url
  };
  } catch (_) {
    return {
      title: 'Untitled',
      platform: 'unknown',
      pageType: 'unknown',
      seriesUrl: '',
      episodeUrl: '',
      sourceUrl: window.location.href
    };
  }
}

async function loadCurrentPage() {
  const tab = await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0]));
  });

  if (!tab?.id || !tab.url) {
    currentShowTitle.textContent = 'No active tab';
    addShowBtn.disabled = true;
    return;
  }

  const isSupported = Boolean(sanitizeStreamUrl(tab.url));
  if (!isSupported) {
    currentShowTitle.textContent = 'Open Netflix, Hulu, or Max to add an item';
    currentShowMeta.textContent = '';
    addShowBtn.disabled = true;
    return;
  }

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    function: getPageInfo
  }, (result) => {
    if (chrome.runtime.lastError || !result?.[0]?.result) {
      currentShowTitle.textContent = 'Could not read the page';
      currentShowMeta.textContent = '';
      addShowBtn.disabled = true;
      return;
    }
    currentItem = result[0].result;
    setCurrentItemUi();
  });
}

async function getActiveSupportedTabAndInfo() {
  const tab = await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0]));
  });
  if (!tab?.id || !tab.url) return null;
  const isSupported = Boolean(sanitizeStreamUrl(tab.url));
  if (!isSupported) return null;

  const info = await new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: getPageInfo
    }, (result) => {
      if (chrome.runtime.lastError || !result?.[0]?.result) {
        resolve(null);
        return;
      }
      resolve(result[0].result);
    });
  });
  return info || null;
}

addChannelBtn.addEventListener('click', async () => {
  const name = newChannelName.value.trim();
  if (!name) return;

  const channels = normalizeChannels(await getStorageChannels());
  if (channels[name]) {
    alert('A channel with this name already exists.');
    return;
  }

  channels[name] = {
    createdAt: Date.now(),
    shuffleMode: 'sequential',
    lastPlayedItemId: '',
    profile: channelProfileFromAppSettings(),
    items: []
  };
  await setStorageChannels(channels);
  expandedChannels.add(name);
  newChannelName.value = '';
  await loadChannels();
});

addShowBtn.addEventListener('click', async () => {
  const channelName = channelSelect.value;
  if (!channelName) return;

  const item = buildItemFromCurrent();
  if (!item) {
    alert('Could not add this page. Try opening a show or episode page first.');
    return;
  }

  const channels = normalizeChannels(await getStorageChannels());
  const channel = channels[channelName];
  if (!channel) return;

  const duplicate = channel.items.some((entry) =>
    entry.platform === item.platform && getPreferredUrl(entry) === getPreferredUrl(item)
  );
  if (duplicate) {
    alert('That item is already in this channel.');
    return;
  }

  channel.items.push(item);
  await setStorageChannels(channels);
  await loadChannels();
});

addBatchBtn?.addEventListener('click', async () => {
  const channelName = channelSelect.value;
  if (!channelName) return;
  const text = String(batchUrlsInput?.value || '');
  const lines = text.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  if (!lines.length) return;

  const channels = normalizeChannels(await getStorageChannels());
  const channel = channels[channelName];
  if (!channel) return;

  const existingKeys = new Set(channel.items.map((item) => getItemIdentityKey(item)));
  let added = 0;
  let skippedInvalid = 0;
  let skippedDuplicate = 0;

  lines.forEach((line) => {
    const item = buildBatchItemFromUrl(line, channelName);
    if (!item) {
      skippedInvalid += 1;
      return;
    }
    const key = getItemIdentityKey(item);
    if (existingKeys.has(key)) {
      skippedDuplicate += 1;
      return;
    }
    existingKeys.add(key);
    channel.items.push(item);
    added += 1;
  });

  await setStorageChannels(channels);
  await loadChannels();
  if (batchUrlsInput) batchUrlsInput.value = '';
  alert(`Batch add complete: added ${added}, duplicates ${skippedDuplicate}, invalid ${skippedInvalid}.`);
});

exportDataBtn.addEventListener('click', async () => {
  const channels = normalizeChannels(await getStorageChannels());
  const settings = normalizeSettings(await getStorageSettings());
  const payload = {
    schemaVersion: 2,
    exportedAt: Date.now(),
    channels,
    streamSettings: settings
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const datePart = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `streamchannel-backup-${datePart}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
});

importDataBtn.addEventListener('click', () => {
  importDataFileInput.value = '';
  importDataFileInput.click();
});

importDataFileInput.addEventListener('change', async () => {
  const file = importDataFileInput.files?.[0];
  if (!file) return;
  let text = '';
  try {
    text = await file.text();
  } catch (_) {
    alert('Could not read selected file.');
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    alert('Invalid JSON file.');
    return;
  }

  const importedChannels = normalizeChannels(parsed?.channels || {});
  const importedSettings = normalizeSettings(parsed?.streamSettings || {});
  await setStorageChannels(importedChannels);
  await setStorageSettings(importedSettings);
  appSettings = importedSettings;
  ccDefaultEnabledInput.checked = appSettings.captionsEnabledDefault;
  maximizePlayerEnabledInput.checked = appSettings.maximizePlayer;
  ccLanguageSelect.value = appSettings.captionsLanguage;
  await refreshPlaybackState();
  await loadChannels();
  alert(`Imported ${Object.keys(importedChannels).length} channel(s).`);
});

backBtn.addEventListener('click', async () => {
  chrome.runtime.sendMessage({ type: 'playbackBack' }, async () => {
    await refreshPlaybackState();
    await loadChannels();
  });
});

skipBtn.addEventListener('click', async () => {
  chrome.runtime.sendMessage({ type: 'playbackSkip' }, async () => {
    await refreshPlaybackState();
    await loadChannels();
  });
});

stopBtn.addEventListener('click', async () => {
  chrome.runtime.sendMessage({ type: 'stopPlayback' }, async () => {
    await refreshPlaybackState();
    await loadChannels();
  });
});

ccDefaultEnabledInput.addEventListener('change', async () => {
  appSettings.captionsEnabledDefault = ccDefaultEnabledInput.checked;
  await setStorageSettings(appSettings);
});

maximizePlayerEnabledInput.addEventListener('change', async () => {
  appSettings.maximizePlayer = maximizePlayerEnabledInput.checked;
  await setStorageSettings(appSettings);
});

ccLanguageSelect.addEventListener('change', async () => {
  appSettings.captionsLanguage = ccLanguageSelect.value;
  await setStorageSettings(appSettings);
});

channelsList.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.classList.contains('toggle-channel-btn')) {
    const channelName = decodeURIComponent(target.dataset.channel || '');
    if (expandedChannels.has(channelName)) expandedChannels.delete(channelName);
    else expandedChannels.add(channelName);
    await loadChannels();
    return;
  }

  if (target.classList.contains('play-channel-btn') || target.classList.contains('start-item-btn')) {
    const channelName = decodeURIComponent(target.dataset.channel || '');
    let startItemId = '';
    if (target.classList.contains('start-item-btn')) {
      startItemId = String(target.dataset.startItemId || '');
      if (!startItemId) {
        const row = target.closest('.start-row');
        const select = row?.querySelector('.start-item-select');
        startItemId = select?.value || '';
      }
      if (startItemId) {
        const channels = normalizeChannels(await getStorageChannels());
        if (channels[channelName]) {
          channels[channelName].lastPlayedItemId = String(startItemId);
          await setStorageChannels(channels);
        }
      }
    }
    chrome.runtime.sendMessage({ type: 'playChannel', channelName, startItemId }, async () => {
      await refreshPlaybackState();
      await loadChannels();
    });
    return;
  }

  if (target.classList.contains('stop-channel-btn')) {
    chrome.runtime.sendMessage({ type: 'stopPlayback' }, async () => {
      await refreshPlaybackState();
      await loadChannels();
    });
    return;
  }

  if (target.classList.contains('randomize-channel-btn')) {
    const channelName = decodeURIComponent(target.dataset.channel || '');
    const channels = normalizeChannels(await getStorageChannels());
    const channel = channels[channelName];
    if (!channel || channel.items.length < 2) return;
    shuffleInPlace(channel.items);
    await setStorageChannels(channels);
    await loadChannels();
    return;
  }

  if (target.classList.contains('clone-channel-btn')) {
    const channelName = decodeURIComponent(target.dataset.channel || '');
    const channels = normalizeChannels(await getStorageChannels());
    const channel = channels[channelName];
    if (!channel) return;
    const baseName = `${channelName} Copy`;
    let nextName = baseName;
    let n = 2;
    while (channels[nextName]) {
      nextName = `${baseName} ${n}`;
      n += 1;
    }
    channels[nextName] = {
      createdAt: Date.now(),
      shuffleMode: String(channel.shuffleMode || 'sequential'),
      lastPlayedItemId: '',
      profile: normalizeChannelProfile(channel.profile) || channelProfileFromAppSettings(),
      items: (channel.items || []).map((item) => ({
        ...item,
        id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        addedAt: Date.now()
      }))
    };
    await setStorageChannels(channels);
    expandedChannels.add(nextName);
    await loadChannels();
    return;
  }

  if (target.classList.contains('dedupe-channel-btn')) {
    const channelName = decodeURIComponent(target.dataset.channel || '');
    const channels = normalizeChannels(await getStorageChannels());
    const channel = channels[channelName];
    if (!channel) return;
    const removed = dedupeChannelItems(channel);
    await setStorageChannels(channels);
    await loadChannels();
    alert(removed > 0
      ? `Removed ${removed} duplicate item(s) from "${channelName}".`
      : `No duplicates found in "${channelName}".`);
    return;
  }

  if (target.classList.contains('delete-channel-btn')) {
    const channelName = decodeURIComponent(target.dataset.channel || '');
    const ok = confirm(`Delete channel "${channelName}"?`);
    if (!ok) return;
    const channels = normalizeChannels(await getStorageChannels());
    delete channels[channelName];
    expandedChannels.delete(channelName);
    await setStorageChannels(channels);
    await refreshPlaybackState();
    await loadChannels();
    return;
  }

  if (target.classList.contains('remove-item-btn')) {
    const channelName = decodeURIComponent(target.dataset.channel || '');
    const itemId = target.dataset.itemId;
    const channels = normalizeChannels(await getStorageChannels());
    if (!channels[channelName]) return;
    channels[channelName].items = channels[channelName].items.filter((item) => item.id !== itemId);
    await setStorageChannels(channels);
    await loadChannels();
    return;
  }

  if (
    target.classList.contains('item-playcount-dec-btn') ||
    target.classList.contains('item-playcount-inc-btn') ||
    target.classList.contains('item-playcount-reset-btn')
  ) {
    const channelName = decodeURIComponent(target.dataset.channel || '');
    const itemId = target.dataset.itemId;
    const channels = normalizeChannels(await getStorageChannels());
    const channel = channels[channelName];
    if (!channel) return;
    const item = channel.items.find((entry) => String(entry?.id || '') === String(itemId || ''));
    if (!item) return;
    const current = Math.max(0, Number(item.playCount || 0) || 0);
    if (target.classList.contains('item-playcount-reset-btn')) {
      item.playCount = 0;
    } else if (target.classList.contains('item-playcount-inc-btn')) {
      item.playCount = current + 1;
    } else {
      item.playCount = Math.max(0, current - 1);
    }
    await setStorageChannels(channels);
    await loadChannels();
    return;
  }

  if (target.classList.contains('open-item-btn')) {
    const channelName = decodeURIComponent(target.dataset.channel || '');
    const itemId = target.dataset.itemId;
    chrome.runtime.sendMessage({ type: 'playItemNow', channelName, itemId }, async () => {
      await refreshPlaybackState();
      await loadChannels();
    });
    return;
  }

  if (target.classList.contains('toggle-cc-btn')) {
    const channelName = decodeURIComponent(target.dataset.channel || '');
    const itemId = target.dataset.itemId;
    const channels = normalizeChannels(await getStorageChannels());
    const channel = channels[channelName];
    if (!channel) return;
    const item = channel.items.find((entry) => entry.id === itemId);
    if (!item) return;
    item.ccEnabled = !item.ccEnabled;
    await setStorageChannels(channels);
    await loadChannels();
    return;
  }

  if (target.classList.contains('repair-item-btn')) {
    const channelName = decodeURIComponent(target.dataset.channel || '');
    const itemId = target.dataset.itemId;
    const channels = normalizeChannels(await getStorageChannels());
    const channel = channels[channelName];
    if (!channel) return;
    const item = channel.items.find((entry) => entry.id === itemId);
    if (!item) return;

    const detected = await getActiveSupportedTabAndInfo();
    if (!detected) {
      alert('Open the correct Netflix/Hulu/Max show page in the active tab, then try Fix URL again.');
      return;
    }

    const patched = sanitizeChannelItem({
      ...item,
      title: detected.title || item.title,
      platform: detected.platform || item.platform,
      seriesUrl: detected.seriesUrl || item.seriesUrl,
      episodeUrl: detected.episodeUrl || item.episodeUrl,
      sourceUrl: detected.sourceUrl || item.sourceUrl
    });
    if (!patched) {
      alert('Detected URL is not on an approved streaming domain.');
      return;
    }
    Object.assign(item, patched);

    await setStorageChannels(channels);
    await loadChannels();
    alert(`Updated "${item.title}" from the current tab.`);
  }
});

channelsList.addEventListener('change', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.classList.contains('start-item-select')) {
    const row = target.closest('.start-row');
    const button = row?.querySelector('.start-item-btn');
    if (button instanceof HTMLElement) {
      button.dataset.startItemId = String(target.value || '');
    }
    const channelName = decodeURIComponent(String(target.dataset.channel || ''));
    const selectedItemId = String(target.value || '');
    if (channelName && selectedItemId) {
      const channels = normalizeChannels(await getStorageChannels());
      if (channels[channelName]) {
        channels[channelName].lastPlayedItemId = selectedItemId;
        await setStorageChannels(channels);
      }
    }
    return;
  }

  if (target.classList.contains('shuffle-mode-select')) {
    const channelName = decodeURIComponent(target.dataset.channel || '');
    const channels = normalizeChannels(await getStorageChannels());
    const channel = channels[channelName];
    if (!channel) return;
    const nextMode = String(target.value || 'sequential');
    channel.shuffleMode = ['sequential', 'random', 'least_played', 'newest'].includes(nextMode)
      ? nextMode
      : 'sequential';
    await setStorageChannels(channels);
    return;
  }

  if (target.classList.contains('item-max-plays-input') || target.classList.contains('item-cooldown-input')) {
    const channelName = decodeURIComponent(target.dataset.channel || '');
    const itemId = String(target.dataset.itemId || '');
    const channels = normalizeChannels(await getStorageChannels());
    const channel = channels[channelName];
    if (!channel) return;
    const item = channel.items.find((entry) => entry.id === itemId);
    if (!item) return;
    if (target.classList.contains('item-max-plays-input')) {
      item.maxPlays = parseNonNegativeInt(target.value);
      target.value = String(item.maxPlays);
    } else {
      item.cooldownMinutes = parseNonNegativeInt(target.value);
      target.value = String(item.cooldownMinutes);
    }
    await setStorageChannels(channels);
    return;
  }

  if (
    target.classList.contains('channel-cc-default-input') ||
    target.classList.contains('channel-max-default-input') ||
    target.classList.contains('channel-cc-language-select')
  ) {
    const channelName = decodeURIComponent(target.dataset.channel || '');
    const channels = normalizeChannels(await getStorageChannels());
    const channel = channels[channelName];
    if (!channel) return;
    channel.profile = normalizeChannelProfile(channel.profile) || channelProfileFromAppSettings();
    if (target.classList.contains('channel-cc-default-input')) {
      channel.profile.ccEnabledDefault = Boolean(target.checked);
    } else if (target.classList.contains('channel-max-default-input')) {
      channel.profile.maximizePlayer = Boolean(target.checked);
    } else {
      channel.profile.captionsLanguage = String(target.value || 'en');
    }
    await setStorageChannels(channels);
  }
});

channelsList.addEventListener('dragstart', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest('.item-actions')) return;
  const row = target.closest('.item-row');
  if (!(row instanceof HTMLElement)) return;

  dragChannelName = decodeURIComponent(row.dataset.channel || '');
  dragItemId = String(row.dataset.itemId || '');
  if (!dragChannelName || !dragItemId) return;

  row.classList.add('dragging');
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragItemId);
  }
});

channelsList.addEventListener('dragover', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest('.item-row');
  if (!(row instanceof HTMLElement)) return;

  const rowChannelName = decodeURIComponent(row.dataset.channel || '');
  const rowItemId = String(row.dataset.itemId || '');
  if (!dragItemId || !dragChannelName || rowChannelName !== dragChannelName || rowItemId === dragItemId) return;

  event.preventDefault();
  const rect = row.getBoundingClientRect();
  const insertAfter = (event.clientY - rect.top) > rect.height / 2;
  clearDragMarkers();
  row.classList.add(insertAfter ? 'drop-after' : 'drop-before');
});

channelsList.addEventListener('drop', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest('.item-row');
  if (!(row instanceof HTMLElement)) return;

  const rowChannelName = decodeURIComponent(row.dataset.channel || '');
  const rowItemId = String(row.dataset.itemId || '');
  if (!dragItemId || !dragChannelName || rowChannelName !== dragChannelName || rowItemId === dragItemId) {
    clearDragMarkers();
    return;
  }

  event.preventDefault();
  const rect = row.getBoundingClientRect();
  const insertAfter = (event.clientY - rect.top) > rect.height / 2;
  await reorderChannelItems(dragChannelName, dragItemId, rowItemId, insertAfter);
  dragChannelName = '';
  dragItemId = '';
  clearDragMarkers();
  await loadChannels();
});

channelsList.addEventListener('dragend', () => {
  dragChannelName = '';
  dragItemId = '';
  clearDragMarkers();
});

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await refreshPlaybackState();
  await loadChannels();
  await loadCurrentPage();
});
