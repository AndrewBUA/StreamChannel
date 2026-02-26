(() => {
  let autoClickTimer = null;
  let routeMonitorTimer = null;
  let lastHandledHref = '';
  const OVERLAY_STYLE_ID = 'stream-channel-netflix-overlay-style';
  let overlayReleaseTimer = null;
  let userReleaseBound = false;
  let controlsVisibleUntil = 0;
  let videoEndObserverBound = false;
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
    if (!automationEnabled && autoClickTimer) {
      clearInterval(autoClickTimer);
      autoClickTimer = null;
    }
    if (!automationEnabled) {
      setOverlaySuppression(false);
      controlsVisibleUntil = 0;
      if (overlayReleaseTimer) {
        clearTimeout(overlayReleaseTimer);
        overlayReleaseTimer = null;
      }
    }
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
    // Netflix automation should not require manual in-player focus.
    return true;
  }

  function captionSyncKey() {
    const lang = String(captionSettings.language || 'en').toLowerCase();
    return captionSettings.enabled ? `on:${lang}` : 'off';
  }

  function isCaptionMenuOpen() {
    const selector = document.querySelector('[data-uia="selector-audio-subtitle"]');
    return Boolean(selector && isVisible(selector));
  }

  function getActiveSubtitleItems() {
    const selectors = Array.from(document.querySelectorAll('[data-uia="selector-audio-subtitle"]'));
    const activeSelector = selectors.find((el) => isVisible(el)) || null;
    if (!activeSelector) return [];
    return Array.from(activeSelector.querySelectorAll('[data-uia^="subtitle-item"]'));
  }

  function isCaptionUiSynced(video) {
    return String(video?.dataset?.streamChannelCaptionUiKey || '') === captionSyncKey();
  }

  function markCaptionUiSynced(video) {
    if (!video) return;
    video.dataset.streamChannelCaptionUiKey = captionSyncKey();
  }

  function hideControlsTemporarily() {
    const controls = Array.from(document.querySelectorAll(
      '[data-uia="controls-standard"], .watch-video--bottom-controls-container, .watch-video--back-container, .watch-video--flag-container'
    ));
    controls.forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      if (el.dataset.streamChannelTempHidden === '1') return;
      el.dataset.streamChannelTempHidden = '1';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      setTimeout(() => {
        el.style.opacity = '';
        el.style.pointerEvents = '';
        delete el.dataset.streamChannelTempHidden;
      }, 1800);
    });
  }

  function setOverlaySuppression(enabled) {
    const existing = document.getElementById(OVERLAY_STYLE_ID);
    if (!enabled) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;

    const style = document.createElement('style');
    style.id = OVERLAY_STYLE_ID;
    style.textContent = `
      [data-uia="controls-standard"],
      .watch-video--bottom-controls-container,
      .watch-video--back-container,
      .watch-video--flag-container {
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function suppressOverlayFor() {
    setOverlaySuppression(true);
    if (overlayReleaseTimer) {
      clearTimeout(overlayReleaseTimer);
      overlayReleaseTimer = null;
    }
  }

  function bindUserReleaseHandlers() {
    if (userReleaseBound) return;
    userReleaseBound = true;

    const release = (event) => {
      if (!event?.isTrusted) return;
      controlsVisibleUntil = Date.now() + 5000;
      setOverlaySuppression(false);
      if (overlayReleaseTimer) {
        clearTimeout(overlayReleaseTimer);
        overlayReleaseTimer = null;
      }
    };
    ['mousedown', 'keydown', 'touchstart'].forEach((eventName) => {
      window.addEventListener(eventName, release, { passive: true });
    });
  }

  function closeCaptionMenu() {
    const startedOpen = isCaptionMenuOpen();
    if (!startedOpen) return;

    const openButton = document.querySelector('[data-uia="control-audio-subtitle"]');
    if (openButton && isVisible(openButton)) {
      clickElement(openButton);
    }

    if (isCaptionMenuOpen()) {
      try {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
        document.body?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        document.body?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
      } catch (_) {}
    }

    if (isCaptionMenuOpen()) {
      const player = document.querySelector('[data-uia="player"], .watch-video--player-view, video') || document.body;
      const rect = player.getBoundingClientRect();
      const x = Math.max(1, rect.left + 12);
      const y = Math.max(1, rect.top + 12);
      try {
        player.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        player.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        player.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      } catch (_) {}
    }

    // Last-resort fallback for stubborn overlays that ignore synthetic close events.
    if (isCaptionMenuOpen()) {
      const selector = document.querySelector('[data-uia="selector-audio-subtitle"]');
      const overlay = selector?.closest('.show') || selector?.parentElement || null;
      if (overlay && overlay instanceof HTMLElement) {
        overlay.classList.remove('show');
        overlay.style.display = 'none';
        overlay.style.visibility = 'hidden';
        overlay.style.pointerEvents = 'none';
      }
      if (selector && selector instanceof HTMLElement) {
        selector.setAttribute('aria-hidden', 'true');
      }
    }

    if (startedOpen && !isCaptionMenuOpen()) {
      hideControlsTemporarily();
    }
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

  function areCaptionsAppliedInUi() {
    const subtitleItems = getActiveSubtitleItems();
    if (!subtitleItems.length) return false;
    const selected = subtitleItems.find((item) => item.getAttribute('data-uia')?.includes('selected-'));
    if (!selected) return false;
    const uia = String(selected.getAttribute('data-uia') || '').toLowerCase();
    if (!captionSettings.enabled) return uia.includes('off');
    return !uia.includes('off');
  }

  function applyCaptionSettingsViaUi() {
    if (!canDriveUiNow()) return;
    setOverlaySuppression(false);
    const selectorAlreadyOpen = Boolean(
      document.querySelector('[data-uia="selector-audio-subtitle"]') &&
      isVisible(document.querySelector('[data-uia="selector-audio-subtitle"]'))
    );
    const openButton = document.querySelector('[data-uia="control-audio-subtitle"]');
    if (!selectorAlreadyOpen && openButton) clickElement(openButton);

    const subtitleItems = getActiveSubtitleItems();
    if (!subtitleItems.length) return;

    let target = null;
    if (!captionSettings.enabled) {
      target = subtitleItems.find((item) => String(item.getAttribute('data-uia') || '').toLowerCase().includes('off'));
    } else {
      const desired = String(captionSettings.language || 'en').toLowerCase();
      if (desired.startsWith('en')) {
        target = subtitleItems.find((item) => {
          const uia = String(item.getAttribute('data-uia') || '').toLowerCase();
          const text = String(item.textContent || '').toLowerCase();
          return uia.includes('english (cc)') || text.includes('english (cc)');
        });
      }
      if (!target) {
        target = subtitleItems.find((item) => {
          const uia = String(item.getAttribute('data-uia') || '').toLowerCase();
          const text = String(item.textContent || '').toLowerCase();
          return uia.includes(desired) || text.includes(desired);
        });
      }
      if (!target && desired.startsWith('en')) {
        target = subtitleItems.find((item) => {
          const uia = String(item.getAttribute('data-uia') || '').toLowerCase();
          const text = String(item.textContent || '').toLowerCase();
          return uia.includes('english') || text.includes('english');
        });
      }
      if (!target) {
        target = subtitleItems.find((item) => !String(item.getAttribute('data-uia') || '').toLowerCase().includes('off'));
      }
    }

    if (!target) target = subtitleItems[0];
    if (target && !String(target.getAttribute('data-uia') || '').includes('selected-')) {
      clickElement(target);
    }
    markCaptionUiSynced(document.querySelector('video'));

    // Close subtitle menu so playback controls return to normal state.
    setTimeout(closeCaptionMenu, 120);
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
    setOverlaySuppression(false);
    controlsVisibleUntil = Math.max(controlsVisibleUntil, Date.now() + 5000);
    nudgeControlsVisible(video);

    const fsButton = document.querySelector(
      '[data-uia="control-fullscreen-enter"], ' +
      '[data-uia*="fullscreen" i], ' +
      'button[aria-label*="full screen" i], ' +
      'button[title*="full screen" i]'
    );
    if (fsButton) {
      video.dataset.streamChannelMaximizeAttempts = String(attempts + 1);
      clickElement(fsButton);
      return;
    }
  }

  function syncPlaybackUi(video) {
    if (!video) return;
    const syncToken = `${window.location.href}|${captionSyncKey()}|${maximizeEnabled ? '1' : '0'}`;
    if (video.dataset.streamChannelSyncInFlight === '1' &&
      video.dataset.streamChannelUiSyncToken === syncToken) {
      return;
    }
    const maximizePending = maximizeEnabled &&
      !document.fullscreenElement &&
      video.dataset.streamChannelMaximizeSettled !== '1';
    const captionsPending = !isCaptionUiSynced(video);
    if (video.dataset.streamChannelUiSyncToken === syncToken && !maximizePending && !captionsPending) return;
    video.dataset.streamChannelSyncInFlight = '1';
    video.dataset.streamChannelUiSyncToken = syncToken;
    video.dataset.streamChannelCaptionUiKey = '';
    video.dataset.streamChannelOverlaySuppressedKey = '';
    video.dataset.streamChannelMaximizeSettled = '';
    video.dataset.streamChannelMaximizeAttempts = '0';
    bindUserReleaseHandlers();

    let attempts = 0;
    let timer = null;
    const trySync = () => {
      attempts += 1;
      applyCaptionSettings(video);
      const captionsAlreadySelectedInUi = areCaptionsAppliedInUi();
      if (!isCaptionUiSynced(video) || !areCaptionsApplied(video)) {
        applyCaptionSettingsViaUi();
        applyCaptionSettings(video);
      }
      closeCaptionMenu();
      applyMaximizeViaUi(video);

      const captionsDone = (areCaptionsApplied(video) ||
        captionsAlreadySelectedInUi ||
        areCaptionsAppliedInUi()) && isCaptionUiSynced(video);
      const maximizeDone = !maximizeEnabled ||
        Boolean(document.fullscreenElement) ||
        video.dataset.streamChannelMaximizeSettled === '1';
      const menuClosed = !isCaptionMenuOpen();
      if (menuClosed) {
        const currentKey = captionSyncKey();
        if (video.dataset.streamChannelOverlaySuppressedKey !== currentKey) {
          video.dataset.streamChannelOverlaySuppressedKey = currentKey;
          suppressOverlayFor();
        }
      }
      if (automationEnabled) {
        if (maximizeEnabled && !maximizeDone) {
          setOverlaySuppression(false);
        } else
        if (Date.now() < controlsVisibleUntil) {
          setOverlaySuppression(false);
        } else {
          setOverlaySuppression(true);
        }
      }
      if ((captionsDone && maximizeDone && menuClosed) || attempts >= 180) {
        if (timer) clearInterval(timer);
        video.dataset.streamChannelSyncInFlight = '0';
      }
    };

    trySync();
    timer = setInterval(trySync, 500);
  }

  function autoClick(selectors, maxMs = 15000) {
    if (autoClickTimer) {
      clearInterval(autoClickTimer);
      autoClickTimer = null;
    }
    const started = Date.now();
    autoClickTimer = setInterval(() => {
      if (!automationEnabled) {
        clearInterval(autoClickTimer);
        autoClickTimer = null;
        return;
      }
      const button = document.querySelector(selectors.join(', '));
      if (button) {
        clearInterval(autoClickTimer);
        autoClickTimer = null;
        button.click();
        return;
      }
      if (Date.now() - started > maxMs) {
        clearInterval(autoClickTimer);
        autoClickTimer = null;
      }
    }, 500);
  }

  function bindVideoEnd() {
    if (videoEndObserverBound) return;
    videoEndObserverBound = true;
    const root = document.documentElement || document.body;
    const attach = () => {
      const video = document.querySelector('video');
      if (!video) return;
      if (video.dataset.streamChannelBound === '1') return;
      video.dataset.streamChannelBound = '1';
      syncPlaybackUi(video);
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

  async function handleRouteChange() {
    if (!(await shouldAutomateHere())) return;
    const href = window.location.href;
    const lowerHref = href.toLowerCase();
    const isWatchPage = lowerHref.includes('/watch/');
    const isTitlePage = /\/title\/\d+/i.test(href) || /[?&]jbv=\d+/i.test(href);
    const video = document.querySelector('video');
    const maximizePending = Boolean(
      maximizeEnabled &&
      video &&
      !document.fullscreenElement &&
      video.dataset.streamChannelMaximizeSettled !== '1'
    );
    if (maximizePending || Date.now() < controlsVisibleUntil) {
      setOverlaySuppression(false);
    } else {
      setOverlaySuppression(true);
    }

    if (href === lastHandledHref) {
      if (isWatchPage) {
        bindVideoEnd();
        syncPlaybackUi(document.querySelector('video'));
      }
      return;
    }
    lastHandledHref = href;
    if (isWatchPage) {
      bindVideoEnd();
      syncPlaybackUi(document.querySelector('video'));
    } else if (isTitlePage) {
      autoClick(['a[data-uia="play-button"]', '.PlayLink', '[data-uia="resume-play-button"]']);
    }
  }

  handleRouteChange().catch(() => {});
  routeMonitorTimer = setInterval(() => {
    handleRouteChange().catch(() => {});
  }, 500);

  chrome.runtime.onMessage.addListener((request) => {
    if (request?.type !== 'streamChannelDeactivate') return false;
    automationEnabled = false;
    if (autoClickTimer) {
      clearInterval(autoClickTimer);
      autoClickTimer = null;
    }
    setOverlaySuppression(false);
    controlsVisibleUntil = 0;
    if (overlayReleaseTimer) {
      clearTimeout(overlayReleaseTimer);
      overlayReleaseTimer = null;
    }
    const videos = document.querySelectorAll('video');
    videos.forEach((video) => {
      try { video.pause(); } catch (_) {}
    });
    return false;
  });
})();
