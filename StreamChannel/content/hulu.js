(() => {
  let playerBound = false;
  let playClicked = false;
  let automationEnabled = false;
  let captionSettings = { enabled: false, language: 'en' };
  let maximizeEnabled = false;

  function queryAutomationState() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'shouldAutomatePlayback' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ enabled: false, captionSettings: { enabled: false, language: 'en' } });
          return;
        }
        resolve({
          enabled: Boolean(response?.enabled),
          captionSettings: {
            enabled: Boolean(response?.captionSettings?.enabled),
            language: String(response?.captionSettings?.language || 'en')
          },
          maximizeEnabled: Boolean(response?.maximizeEnabled)
        });
      });
    });
  }

  async function shouldAutomateHere() {
    const state = await queryAutomationState();
    automationEnabled = state.enabled;
    captionSettings = state.captionSettings;
    maximizeEnabled = state.maximizeEnabled;
    return automationEnabled;
  }

  function applyCaptionSettings(video) {
    if (!video?.textTracks) return;
    const tracks = Array.from(video.textTracks);
    if (!tracks.length) return;

    if (!captionSettings.enabled) {
      tracks.forEach((track) => {
        try { track.mode = 'disabled'; } catch (_) {}
      });
      return;
    }

    const desired = String(captionSettings.language || 'en').toLowerCase();
    let chosen = tracks.find((track) => String(track.language || '').toLowerCase() === desired);
    if (!chosen && desired.startsWith('en')) {
      chosen = tracks.find((track) => String(track.language || '').toLowerCase().startsWith('en'));
    }
    if (!chosen) {
      chosen = tracks.find((track) => String(track.kind || '').toLowerCase().includes('capt')) || tracks[0];
    }

    tracks.forEach((track) => {
      try { track.mode = track === chosen ? 'showing' : 'disabled'; } catch (_) {}
    });
  }

  function captionSyncKey() {
    const lang = String(captionSettings.language || 'en').toLowerCase();
    return captionSettings.enabled ? `on:${lang}` : 'off';
  }

  function isCaptionUiSynced(video) {
    return String(video?.dataset?.streamChannelCaptionUiKey || '') === captionSyncKey();
  }

  function markCaptionUiSynced(video) {
    if (!video) return;
    video.dataset.streamChannelCaptionUiKey = captionSyncKey();
  }

  function areCaptionsAppliedInUi() {
    const subtitleOptions = Array.from(document.querySelectorAll(
      '.controls__setting-col.controls__setting-subtitles [role="radio"], ' +
      '.controls__setting-bd[aria-label="subtitles"] [role="radio"], ' +
      '.controls__setting-subtitles .controls__setting-option'
    ));
    if (!subtitleOptions.length) return false;

    const selected = subtitleOptions.find((option) => {
      const checked = String(option.getAttribute('aria-checked') || '').toLowerCase() === 'true';
      return checked || option.classList.contains('controls__setting-option--selected');
    });
    if (!selected) return false;

    const val = String(selected.getAttribute('data-val') || '').toLowerCase();
    const text = String(selected.textContent || '').toLowerCase().trim();
    if (!captionSettings.enabled) return val === 'off' || text === 'off';
    return val !== 'off' && text !== 'off';
  }

  function areCaptionsApplied(video) {
    if (!video?.textTracks) return false;
    const tracks = Array.from(video.textTracks);
    if (!tracks.length) return false;
    if (!captionSettings.enabled) {
      return tracks.every((track) => String(track.mode || '').toLowerCase() !== 'showing');
    }
    return tracks.some((track) => String(track.mode || '').toLowerCase() === 'showing');
  }

  function nudgeControlsVisible(video) {
    const target = video || document.querySelector('video') || document.body;
    if (!target) return;
    ['mousemove', 'mouseover'].forEach((type) => {
      try {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch (_) {}
    });
  }

  function canDriveUiNow() {
    // Hulu runs from popup-driven navigation; visibility is a better gate than strict focus.
    return document.visibilityState === 'visible';
  }

  function applyCaptionSettingsViaUi() {
    if (!canDriveUiNow()) return;
    nudgeControlsVisible(document.querySelector('video'));

    const settingsButton = document.querySelector('[aria-label="Settings"], .SettingsButton');
    if (settingsButton) {
      clickElement(settingsButton);
    }

    const languageMenuItem = document.querySelector('.controls__setting-item.controls__setting-language');
    if (languageMenuItem) {
      clickElement(languageMenuItem);
    }

    const options = Array.from(document.querySelectorAll(
      '.controls__setting-col.controls__setting-subtitles [role="radio"], ' +
      '.controls__setting-bd[aria-label="subtitles"] [role="radio"], ' +
      '.controls__setting-subtitles .controls__setting-option'
    ));
    if (!options.length) return;

    let target = null;
    if (!captionSettings.enabled) {
      target = options.find((option) => String(option.getAttribute('data-val') || '').toLowerCase() === 'off') ||
        options.find((option) => String(option.textContent || '').toLowerCase().trim() === 'off');
    } else {
      const desired = String(captionSettings.language || 'en').toLowerCase();
      target = options.find((option) => String(option.getAttribute('data-val') || '').toLowerCase() === desired);
      if (!target && desired.startsWith('en')) {
        target = options.find((option) => {
          const val = String(option.getAttribute('data-val') || '').toLowerCase();
          const text = String(option.textContent || '').toLowerCase();
          return val.includes('en') || text.includes('english');
        });
      }
      if (!target) {
        target = options.find((option) => {
          const val = String(option.getAttribute('data-val') || '').toLowerCase();
          const text = String(option.textContent || '').toLowerCase().trim();
          return val !== 'off' && text !== 'off';
        });
      }
    }

    if (!target) target = options[0];
    if (!target) return;

    const selected = String(target.getAttribute('aria-checked') || '').toLowerCase() === 'true' ||
      target.classList.contains('controls__setting-option--selected');
    if (!selected) clickElement(target);
    markCaptionUiSynced(document.querySelector('video'));
  }

  function applyMaximizeViaUi(video) {
    if (!maximizeEnabled) return;
    if (!video) return;
    if (!canDriveUiNow()) return;
    if (document.fullscreenElement) return;

    const attempts = Number(video.dataset.streamChannelMaximizeAttempts || '0');
    if (attempts >= 60) {
      return;
    }
    video.dataset.streamChannelMaximizeAttempts = String(attempts + 1);

    nudgeControlsVisible(video);
    const fullButton = document.querySelector(
      '[aria-label*="FULL SCREEN" i], [aria-label*="FULLSCREEN" i], [data-testid*="fullscreen" i]'
    );
    if (fullButton) {
      clickElement(fullButton);
      return;
    }
  }

  function syncCaptions(video) {
    if (!video) return;
    const syncToken = `${window.location.href}|${captionSyncKey()}|${maximizeEnabled ? '1' : '0'}`;
    if (video.dataset.streamChannelSyncInFlight === '1' &&
      video.dataset.streamChannelCaptionSyncToken === syncToken) {
      return;
    }
    if (video.dataset.streamChannelCaptionSyncToken === syncToken) return;
    video.dataset.streamChannelSyncInFlight = '1';
    video.dataset.streamChannelCaptionSyncToken = syncToken;
    video.dataset.streamChannelCaptionUiKey = '';
    video.dataset.streamChannelMaximizeSettled = '';
    video.dataset.streamChannelMaximizeAttempts = '0';

    let attempts = 0;
    let timer = null;
    const trySync = () => {
      attempts += 1;
      applyCaptionSettings(video);
      const captionsApplied = areCaptionsApplied(video);
      if (!isCaptionUiSynced(video) && captionsApplied) {
        markCaptionUiSynced(video);
      } else if (!isCaptionUiSynced(video) || !captionsApplied) {
        applyCaptionSettingsViaUi();
        applyCaptionSettings(video);
      }
      applyMaximizeViaUi(video);
      const captionsDone = (areCaptionsApplied(video) || areCaptionsAppliedInUi()) && isCaptionUiSynced(video);
      const maximizeDone = !maximizeEnabled ||
        Boolean(document.fullscreenElement) ||
        video.dataset.streamChannelMaximizeSettled === '1';
      if ((captionsDone && maximizeDone) || attempts >= 60) {
        if (timer) clearInterval(timer);
        video.dataset.streamChannelSyncInFlight = '0';
      }
    };

    trySync();
    timer = setInterval(trySync, 500);
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function clickElement(el) {
    try {
      el.click();
    } catch (_) {}
    ['mousedown', 'mouseup', 'click'].forEach((type) => {
      try {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch (_) {}
    });
  }

  function clickStartOverIfPresent() {
    const startOver = document.querySelector(
      '[aria-label="START OVER"], [aria-label*="Start Over"], button[title*="Start Over"]'
    );
    if (startOver) clickElement(startOver);
  }

  function forceStartFromBeginning(video) {
    if (!video || video.dataset.streamChannelRestarted === '1') return;
    video.dataset.streamChannelRestarted = '1';

    const restart = () => {
      clickStartOverIfPresent();
      try {
        if (video.currentTime > 0.15) video.currentTime = 0;
      } catch (_) {}
      video.play().catch(() => {});
    };

    restart();
    video.addEventListener('loadedmetadata', restart);
    video.addEventListener('canplay', restart);
    video.addEventListener('playing', restart);

    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      restart();
      if (attempts >= 35) {
        clearInterval(timer);
        video.removeEventListener('loadedmetadata', restart);
        video.removeEventListener('canplay', restart);
        video.removeEventListener('playing', restart);
      }
    }, 120);
  }

  function bindVideoEnd() {
    if (playerBound) return;
    playerBound = true;

    const root = document.documentElement || document.body;
    const attach = () => {
      const video = document.querySelector('video');
      syncCaptions(video);
      if (!video || video.dataset.streamChannelBound === '1') return;
      video.dataset.streamChannelBound = '1';
      forceStartFromBeginning(video);
      if (video.dataset.streamChannelAdvanceBound === '1') return;
      video.dataset.streamChannelAdvanceBound = '1';

      let sent = false;
      const notifyEnded = () => {
        if (sent || !automationEnabled) return;
        sent = true;
        video.removeEventListener('timeupdate', onTimeUpdate);
        chrome.runtime.sendMessage({ type: 'episodeEnded' });
      };

      const onTimeUpdate = () => {
        if (sent || !automationEnabled) return;
        const duration = Number(video.duration || 0);
        const current = Number(video.currentTime || 0);
        if (duration > 0 && duration - current <= 1) {
          notifyEnded();
        }
      };

      video.addEventListener('ended', notifyEnded, { once: true });
      video.addEventListener('timeupdate', onTimeUpdate);
    };

    attach();
    const observer = new MutationObserver(attach);
    observer.observe(root, { childList: true, subtree: true });
  }

  function tryClickPlayButton() {
    if (playClicked) return true;

    const selectors = [
      '[aria-label*="Resume Episode"]',
      '[aria-label*="Play Episode"]',
      'button[aria-label*="Resume"]',
      'button[aria-label*="Play"]',
      'a[aria-label*="Resume"]',
      'a[aria-label*="Play"]',
      'button[data-testid*="play"]',
      'a[data-testid*="play"]'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) {
        clickElement(el);
        playClicked = true;
        return true;
      }
    }

    const candidates = document.querySelectorAll('button, [role="button"], a');
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

      const looksPlayable =
        label.includes('resume episode') ||
        label.includes('play episode') ||
        label.includes('start watching') ||
        label === 'play' ||
        label.startsWith('play ') ||
        label.includes('resume');

      if (!looksPlayable) continue;
      if (label.includes('trailer')) continue;

      clickElement(el);
      playClicked = true;
      return true;
    }

    return false;
  }

  async function handleRoute() {
    if (!(await shouldAutomateHere())) return;

    const url = window.location.href.toLowerCase();
    const isWatchPage = url.includes('/watch/');
    const isSeriesPage = url.includes('/series/');

    if (isWatchPage) {
      bindVideoEnd();
      syncCaptions(document.querySelector('video'));
      return;
    }

    if (window.self === window.top && isSeriesPage) {
      tryClickPlayButton();
    }
  }

  handleRoute().catch(() => {});
  const routeWatcher = setInterval(() => {
    handleRoute().catch(() => {});
  }, 500);

  chrome.runtime.onMessage.addListener((request) => {
    if (request?.type !== 'streamChannelDeactivate') return false;
    automationEnabled = false;
    const videos = document.querySelectorAll('video');
    videos.forEach((video) => {
      try { video.pause(); } catch (_) {}
    });
    return false;
  });
})();
