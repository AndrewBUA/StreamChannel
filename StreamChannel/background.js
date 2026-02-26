const PLAYBACK_KEY = 'playbackState';
const ALLOWED_STREAM_ORIGINS = new Set([
  'https://www.netflix.com',
  'https://www.hulu.com',
  'https://play.hbomax.com'
]);

function defaultPlaybackState() {
  return {
    running: false,
    channelName: '',
    lastItemId: '',
    history: [],
    historyIndex: -1,
    startedAt: 0,
    playbackTabId: null,
    captionSettings: {
      enabled: false,
      language: 'en'
    },
    maximizeEnabled: false
  };
}

function normalizePlaybackState(state) {
  const base = { ...defaultPlaybackState(), ...(state || {}) };
  if (!Array.isArray(base.history)) base.history = [];
  if (typeof base.historyIndex !== 'number') base.historyIndex = base.history.length - 1;
  if (base.historyIndex >= base.history.length) base.historyIndex = base.history.length - 1;
  if (base.historyIndex < -1) base.historyIndex = -1;
  if (typeof base.playbackTabId !== 'number') base.playbackTabId = null;
  return base;
}

function getSyncChannels() {
  return new Promise((resolve) => {
    chrome.storage.sync.get('channels', (data) => resolve(data.channels || {}));
  });
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

function normalizeSettings(rawSettings) {
  const base = { ...defaultSettings(), ...(rawSettings || {}) };
  return {
    captionsEnabledDefault: Boolean(base.captionsEnabledDefault),
    captionsLanguage: String(base.captionsLanguage || 'en'),
    maximizePlayer: Boolean(base.maximizePlayer)
  };
}

function getSyncSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get('streamSettings', (data) => {
      resolve(normalizeSettings(data.streamSettings));
    });
  });
}

function setSyncChannels(channels) {
  return new Promise((resolve) => chrome.storage.sync.set({ channels }, resolve));
}

function getLocalPlaybackState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(PLAYBACK_KEY, (data) => {
      resolve(normalizePlaybackState(data[PLAYBACK_KEY]));
    });
  });
}

function setLocalPlaybackState(state) {
  return new Promise((resolve) => chrome.storage.local.set({ [PLAYBACK_KEY]: state }, resolve));
}

function playbackStateForUi(state) {
  const clean = normalizePlaybackState(state);
  return {
    ...clean,
    canGoBack: clean.running && clean.historyIndex > 0,
    canGoForward: clean.running && clean.historyIndex >= 0 && clean.historyIndex < clean.history.length - 1
  };
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

function normalizeNetflixPlayableUrl(url) {
  if (!url) return '';
  const value = String(url);
  const titleMatch = value.match(/^https:\/\/www\.netflix\.com\/title\/(\d+)/i);
  if (titleMatch?.[1]) {
    return `https://www.netflix.com/title/${titleMatch[1]}`;
  }

  const jbvMatch = value.match(/^https:\/\/www\.netflix\.com\/browse\?jbv=(\d+)/i);
  if (jbvMatch?.[1]) {
    return `https://www.netflix.com/title/${jbvMatch[1]}`;
  }

  const watchMatch = value.match(/^https:\/\/www\.netflix\.com\/watch\/(\d+)/i);
  if (watchMatch?.[1]) {
    return `https://www.netflix.com/watch/${watchMatch[1]}`;
  }
  return value;
}

function getNetflixIdFromUrl(url, segment) {
  if (!url) return '';
  const match = String(url).match(new RegExp(`\\/` + segment + `\\/(\\d+)`, 'i'));
  return match?.[1] || '';
}

function getNetflixJbvId(url) {
  if (!url) return '';
  const match = String(url).match(/[?&]jbv=(\d+)/i);
  return match?.[1] || '';
}

function getHuluWatchUrl(url) {
  if (!url) return '';
  const match = String(url).match(/^https:\/\/www\.hulu\.com\/watch\/[a-z0-9-]+/i);
  return match?.[0] || '';
}

function getHuluSeriesUrl(url) {
  if (!url) return '';
  const match = String(url).match(/^https:\/\/www\.hulu\.com\/series\/[a-z0-9-]+/i);
  return match?.[0] || '';
}

function getPlayableUrl(item) {
  const seriesUrl = sanitizeStreamUrl(item?.seriesUrl || '');
  const sourceUrl = sanitizeStreamUrl(item?.sourceUrl || '');
  const episodeUrl = sanitizeStreamUrl(item?.episodeUrl || '');
  if (item.platform === 'netflix') {
    const seriesId = getNetflixIdFromUrl(seriesUrl, 'title') || getNetflixJbvId(seriesUrl);
    const episodeId = getNetflixIdFromUrl(episodeUrl, 'watch');
    const sourceWatchId = getNetflixIdFromUrl(sourceUrl, 'watch');
    const trustedWatchId = sourceWatchId || (episodeId && episodeId !== seriesId ? episodeId : '');

    const candidates = trustedWatchId
      ? [
          `https://www.netflix.com/watch/${trustedWatchId}`,
          seriesUrl,
          sourceUrl,
          episodeUrl
        ].map(normalizeNetflixPlayableUrl)
      : [seriesUrl, sourceUrl, episodeUrl].map(normalizeNetflixPlayableUrl);

    return candidates.map(sanitizeStreamUrl).find((value) => value) || '';
  }
  if (item.platform === 'hulu') {
    // Prefer concrete watch URLs to avoid Hulu resuming an unrelated title from series/home state.
    const watchCandidates = [episodeUrl, sourceUrl, seriesUrl]
      .map(getHuluWatchUrl)
      .filter(Boolean);
    if (watchCandidates.length) return watchCandidates[0];

    const seriesCandidates = [seriesUrl, sourceUrl, episodeUrl]
      .map(getHuluSeriesUrl)
      .filter(Boolean);
    if (seriesCandidates.length) return seriesCandidates[0];
  }
  return episodeUrl || sourceUrl || seriesUrl || '';
}

function getItemIndex(items, itemId) {
  const wanted = String(itemId || '');
  return items.findIndex((item) => String(item?.id || '') === wanted);
}

function normalizeShuffleMode(mode) {
  const value = String(mode || 'sequential');
  return ['sequential', 'random', 'least_played', 'newest'].includes(value)
    ? value
    : 'sequential';
}

function isItemEligible(item, nowMs = Date.now()) {
  if (!item) return false;
  const playCount = Math.max(0, Number(item.playCount || 0) || 0);
  const maxPlays = Math.max(0, Number(item.maxPlays || 0) || 0);
  const lastPlayedAt = Math.max(0, Number(item.lastPlayedAt || 0) || 0);
  const cooldownMinutes = Math.max(0, Number(item.cooldownMinutes || 0) || 0);

  if (maxPlays > 0 && playCount >= maxPlays) return false;
  if (cooldownMinutes > 0 && lastPlayedAt > 0) {
    const readyAt = lastPlayedAt + (cooldownMinutes * 60 * 1000);
    if (readyAt > nowMs) return false;
  }
  return true;
}

function pickNextIndexByMode(items, currentIndex, mode) {
  if (!items.length) return -1;
  const normalizedMode = normalizeShuffleMode(mode);
  if (normalizedMode === 'sequential') {
    return currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
  }
  if (normalizedMode === 'random') {
    if (items.length === 1) return 0;
    let idx = Math.floor(Math.random() * items.length);
    if (idx === currentIndex) idx = (idx + 1) % items.length;
    return idx;
  }
  if (normalizedMode === 'least_played') {
    let bestIdx = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    items.forEach((item, index) => {
      const score = Math.max(0, Number(item.playCount || 0) || 0);
      if (score < bestScore) {
        bestScore = score;
        bestIdx = index;
      }
    });
    return bestIdx;
  }
  // newest
  let newestIdx = 0;
  let newestScore = Number.NEGATIVE_INFINITY;
  items.forEach((item, index) => {
    const score = Math.max(0, Number(item.addedAt || 0) || 0);
    if (score > newestScore) {
      newestScore = score;
      newestIdx = index;
    }
  });
  return newestIdx;
}

function queryTabs(queryInfo) {
  return new Promise((resolve) => chrome.tabs.query(queryInfo, resolve));
}

function updateTab(tabId, updateProperties) {
  return new Promise((resolve) => chrome.tabs.update(tabId, updateProperties, resolve));
}

function createTab(createProperties) {
  return new Promise((resolve) => chrome.tabs.create(createProperties, resolve));
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    if (typeof tabId !== 'number') {
      resolve();
      return;
    }
    chrome.tabs.sendMessage(tabId, message, () => {
      // Expected when the tab has no injected content script for our hosts.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function getTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tab || null);
    });
  });
}

function isUsableNavigationTab(tab) {
  if (!tab?.id) return false;
  const value = String(tab.url || '').toLowerCase();
  return !value.startsWith('chrome://') &&
    !value.startsWith('edge://') &&
    !value.startsWith('about:') &&
    !value.startsWith('chrome-extension://');
}

async function getChannelsAndPersistNormalized() {
  const rawChannels = await getSyncChannels();
  const channels = normalizeChannels(rawChannels);
  await setSyncChannels(channels);
  return channels;
}

async function openItemInPlatform(item, preferredTabId = null) {
  const url = sanitizeStreamUrl(getPlayableUrl(item));
  if (!url) return null;

  try {
    new URL(url);
  } catch (_) {
    return null;
  }

  if (typeof preferredTabId === 'number') {
    const preferredTab = await getTab(preferredTabId);
    if (isUsableNavigationTab(preferredTab)) {
      const updated = await updateTab(preferredTab.id, { url, active: true });
      return updated?.id || preferredTab.id;
    }
  }

  const [activeTab] = await queryTabs({ active: true, currentWindow: true });
  if (isUsableNavigationTab(activeTab)) {
    const updated = await updateTab(activeTab.id, { url, active: true });
    return updated?.id || activeTab.id;
  }

  const allTabs = await queryTabs({});
  const fallbackTab = allTabs.find(isUsableNavigationTab);
  if (fallbackTab?.id) {
    const updated = await updateTab(fallbackTab.id, { url, active: true });
    return updated?.id || fallbackTab.id;
  }

  const created = await createTab({ url, active: true });
  return created?.id || null;
}

async function touchItemPlayStats(channelName, itemId) {
  const rawChannels = await getSyncChannels();
  const channels = normalizeChannels(rawChannels);
  const channel = channels[channelName];
  if (!channel) return;

  const wanted = String(itemId || '');
  const item = channel.items.find((entry) => String(entry?.id || '') === wanted);
  if (!item) return;

  item.playCount = (item.playCount || 0) + 1;
  item.lastPlayedAt = Date.now();
  channel.lastPlayedItemId = item.id;
  await setSyncChannels(channels);
}

async function playItemWithState(channelName, item, state, mode, channelProfile = null) {
  const previousTabId = typeof state?.playbackTabId === 'number' ? state.playbackTabId : null;
  const openedTabId = await openItemInPlatform(item, state?.playbackTabId || null);
  if (!openedTabId) return false;

  const settings = await getSyncSettings();
  const profile = normalizeChannelProfile(channelProfile);
  const ccEnabled = typeof item?.ccEnabled === 'boolean'
    ? item.ccEnabled
    : (typeof profile?.ccEnabledDefault === 'boolean'
      ? profile.ccEnabledDefault
      : Boolean(settings.captionsEnabledDefault));

  let nextState = normalizePlaybackState(state);
  if (mode === 'reset') {
    nextState.history = [item.id];
    nextState.historyIndex = 0;
  } else if (mode === 'back') {
    nextState.historyIndex = Math.max(0, nextState.historyIndex - 1);
  } else if (mode === 'forward') {
    nextState.historyIndex = Math.min(nextState.history.length - 1, nextState.historyIndex + 1);
  } else {
    const history = nextState.history.slice(0, nextState.historyIndex + 1);
    history.push(item.id);
    nextState.history = history;
    nextState.historyIndex = history.length - 1;
  }

  nextState.running = true;
  nextState.channelName = channelName;
  nextState.lastItemId = item.id;
  nextState.startedAt = Date.now();
  nextState.playbackTabId = openedTabId;
  nextState.captionSettings = {
    enabled: Boolean(ccEnabled),
    language: profile?.captionsLanguage || settings.captionsLanguage || 'en'
  };
  nextState.maximizeEnabled = typeof profile?.maximizePlayer === 'boolean'
    ? profile.maximizePlayer
    : Boolean(settings.maximizePlayer);
  await setLocalPlaybackState(nextState);
  if (previousTabId && previousTabId !== openedTabId) {
    await sendTabMessage(previousTabId, { type: 'streamChannelDeactivate' });
  }
  await touchItemPlayStats(channelName, item.id);
  return true;
}

async function playChannel(channelName, startItemId = '') {
  const channels = await getChannelsAndPersistNormalized();
  const channel = channels[channelName];
  if (!channel || !channel.items.length) {
    await setLocalPlaybackState(defaultPlaybackState());
    return;
  }

  let item = null;
  if (startItemId) {
    const wanted = String(startItemId || '');
    item = channel.items.find((entry) => String(entry?.id || '') === wanted) || null;
    if (!item && /^\d+$/.test(wanted)) {
      const idx = Number(wanted);
      if (idx >= 0 && idx < channel.items.length) item = channel.items[idx];
    }
  }
  if (!item && channel.lastPlayedItemId) {
    const wanted = String(channel.lastPlayedItemId || '');
    item = channel.items.find((entry) => String(entry?.id || '') === wanted) || null;
  }
  if (!item) {
    item = channel.items[0];
  }
  if (!item) return;
  channel.lastPlayedItemId = String(item.id || '');
  await setSyncChannels(channels);
  await playItemWithState(channelName, item, defaultPlaybackState(), 'reset', channel.profile);
}

async function playItemNow(channelName, itemId) {
  const channels = await getChannelsAndPersistNormalized();
  const channel = channels[channelName];
  if (!channel || !channel.items.length) return;

  const wanted = String(itemId || '');
  const item = channel.items.find((entry) => String(entry?.id || '') === wanted);
  if (!item) return;

  const state = await getLocalPlaybackState();
  const mode = state.channelName === channelName ? 'append' : 'reset';
  await playItemWithState(channelName, item, mode === 'reset' ? defaultPlaybackState() : state, mode, channel.profile);
}

async function playNext(channelName, preferForwardHistory = true) {
  const channels = await getChannelsAndPersistNormalized();
  const channel = channels[channelName];
  if (!channel || !channel.items.length) {
    await setLocalPlaybackState(defaultPlaybackState());
    return;
  }

  const state = await getLocalPlaybackState();
  if (preferForwardHistory && state.channelName === channelName && state.historyIndex < state.history.length - 1) {
    const forwardItemId = String(state.history[state.historyIndex + 1] || '');
    const forwardItem = channel.items.find((entry) => String(entry?.id || '') === forwardItemId);
    if (forwardItem) {
      await playItemWithState(channelName, forwardItem, state, 'forward', channel.profile);
      return;
    }
  }

  const nowMs = Date.now();
  const eligibleItems = channel.items.filter((item) => isItemEligible(item, nowMs));
  const candidateItems = eligibleItems.length ? eligibleItems : channel.items;
  const currentIndex = getItemIndex(candidateItems, state.lastItemId);
  const nextIndex = pickNextIndexByMode(candidateItems, currentIndex, channel.shuffleMode);
  const nextItem = candidateItems[nextIndex];
  if (!nextItem) return;
  const baseState = state.channelName === channelName ? state : defaultPlaybackState();
  await playItemWithState(
    channelName,
    nextItem,
    baseState,
    state.channelName === channelName ? 'append' : 'reset',
    channel.profile
  );
}

async function playPrevious() {
  const state = await getLocalPlaybackState();
  if (!state.running || !state.channelName || state.historyIndex <= 0) return;

  const channels = await getChannelsAndPersistNormalized();
  const channel = channels[state.channelName];
  if (!channel || !channel.items.length) return;

  const prevItemId = String(state.history[state.historyIndex - 1] || '');
  const prevItem = channel.items.find((entry) => String(entry?.id || '') === prevItemId);
  if (!prevItem) return;
  await playItemWithState(state.channelName, prevItem, state, 'back', channel.profile);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'playChannel') {
    playChannel(request.channelName, request.startItemId || '').then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.type === 'playItemNow') {
    playItemNow(request.channelName, request.itemId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.type === 'playbackSkip') {
    getLocalPlaybackState().then((state) => {
      if (!state.running || !state.channelName) {
        sendResponse({ ok: false });
        return;
      }
      playNext(state.channelName, true).then(() => sendResponse({ ok: true }));
    });
    return true;
  }

  if (request.type === 'playbackBack') {
    playPrevious().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.type === 'stopPlayback') {
    getLocalPlaybackState().then((state) => {
      const tabId = typeof state?.playbackTabId === 'number' ? state.playbackTabId : null;
      Promise.resolve()
        .then(() => (tabId ? sendTabMessage(tabId, { type: 'streamChannelDeactivate' }) : null))
        .then(() => setLocalPlaybackState(defaultPlaybackState()))
        .then(() => sendResponse({ ok: true }));
    });
    return true;
  }

  if (request.type === 'getPlaybackState') {
    getLocalPlaybackState().then((state) => sendResponse(playbackStateForUi(state)));
    return true;
  }

  if (request.type === 'shouldAutomatePlayback') {
    getLocalPlaybackState().then((state) => {
      const senderTabId = sender?.tab?.id;
      const enabled = Boolean(
        state.running &&
        typeof senderTabId === 'number' &&
        senderTabId === state.playbackTabId
      );
      sendResponse({
        enabled,
        captionSettings: {
          enabled: Boolean(state?.captionSettings?.enabled),
          language: String(state?.captionSettings?.language || 'en')
        },
        maximizeEnabled: Boolean(state?.maximizeEnabled)
      });
    });
    return true;
  }

  if (request.type === 'episodeEnded') {
    getLocalPlaybackState().then((state) => {
      if (!state.running || !state.channelName) return;
      setTimeout(() => {
        playNext(state.channelName, true).catch(() => {});
      }, 1500);
    });
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
