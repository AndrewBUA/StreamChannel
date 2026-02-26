(() => {
  let automationEnabled = false;
  let captionSettings = { enabled: false, language: 'en' };
  let maximizeEnabled = false;
  let lastHandledHref = '';
  let videoEndObserverBound = false;

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

  function isCaptionOffOption(option) {
    const label = String(option?.getAttribute('aria-label') || option?.textContent || '').toLowerCase().trim();
    return label.includes(' off') ||
      label.startsWith('off') ||
      label.includes('none') ||
      label.includes('disabled');
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
    const options = Array.from(document.querySelectorAll('[data-testid="player-ux-text-track-button"][role="radio"]'));
    if (!options.length) return false;
    const selected = options.find((option) => String(option.getAttribute('aria-checked') || '').toLowerCase() === 'true');
    if (!selected) return false;
    if (!captionSettings.enabled) return isCaptionOffOption(selected);
    return !isCaptionOffOption(selected);
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
    // Max runs from popup-driven navigation; visibility is a better gate than strict focus.
    return document.visibilityState === 'visible';
  }

  function getFullscreenButton() {
    return document.querySelector(
      '[data-testid="player-ux-fullscreen-button"], ' +
      '[data-testid*="fullscreen" i], ' +
      'button[aria-label*="full screen" i], ' +
      'button[title*="full screen" i], ' +
      'button[aria-label*="maximize" i]'
    );
  }

  function isMaximizedInUi() {
    if (document.fullscreenElement) return true;
    const button = getFullscreenButton();
    if (!button) return false;
    const label = (
      String(button.getAttribute('aria-label') || '') + ' ' +
      String(button.getAttribute('title') || '') + ' ' +
      String(button.getAttribute('data-testid') || '')
    ).toLowerCase();
    return label.includes('exit full') ||
      label.includes('minimize') ||
      label.includes('shrink') ||
      label.includes('compress');
  }

  function applyCaptionSettingsViaUi() {
    if (!canDriveUiNow()) return;
    nudgeControlsVisible(document.querySelector('video'));

    const trackSelectorButton = document.querySelector(
      '[data-testid="player-ux-track-selector-button"], [aria-label*="subtitle" i], [aria-label*="audio and subtitles" i]'
    );
    if (trackSelectorButton && isVisible(trackSelectorButton)) {
      clickElement(trackSelectorButton);
    }

    const options = Array.from(document.querySelectorAll('[data-testid="player-ux-text-track-button"][role="radio"]'));
    if (!options.length) return;

    let target = null;
    if (!captionSettings.enabled) {
      target = options.find((option) => isCaptionOffOption(option));
    } else {
      const desired = String(captionSettings.language || 'en').toLowerCase();
      target = options.find((option) => {
        const label = String(option.getAttribute('aria-label') || option.textContent || '').toLowerCase();
        return label.includes(desired);
      });
      if (!target && desired.startsWith('en')) {
        target = options.find((option) => {
          const label = String(option.getAttribute('aria-label') || option.textContent || '').toLowerCase();
          return label.includes('english');
        });
      }
      if (!target) {
        target = options.find((option) => !isCaptionOffOption(option));
      }
    }

    if (!target) target = options[0];
    if (!target) return;
    const selected = String(target.getAttribute('aria-checked') || '').toLowerCase() === 'true';
    if (!selected) clickElement(target);
    markCaptionUiSynced(document.querySelector('video'));

    // Close the subtitles/audio menu after applying the setting.
    setTimeout(() => {
      const dismissButton = document.querySelector('[data-testid="player-ux-track-dismiss-button"]');
      if (dismissButton && isVisible(dismissButton)) {
        clickElement(dismissButton);
      }
    }, 120);
  }

  function applyMaximizeViaUi(video) {
    if (!maximizeEnabled) return;
    if (!video) return;
    if (!canDriveUiNow()) return;
    if (isMaximizedInUi()) {
      video.dataset.streamChannelMaximizeSettled = '1';
      return;
    }

    const attempts = Number(video.dataset.streamChannelMaximizeAttempts || '0');
    if (attempts >= 60) {
      return;
    }
    const nextAttempts = attempts + 1;
    video.dataset.streamChannelMaximizeAttempts = String(nextAttempts);

    if (nextAttempts <= 6) nudgeControlsVisible(video);
    const fullButton = getFullscreenButton();
    if (fullButton) {
      const label = (
        String(fullButton.getAttribute('aria-label') || '') + ' ' +
        String(fullButton.getAttribute('title') || '') + ' ' +
        String(fullButton.getAttribute('data-testid') || '')
      ).toLowerCase();
      if (label.includes('exit full') || label.includes('minimize')) {
        video.dataset.streamChannelMaximizeSettled = '1';
        return;
      }
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
    video.dataset.streamChannelCaptionUiAttempts = '0';
    video.dataset.streamChannelMaximizeSettled = '';
    video.dataset.streamChannelMaximizeAttempts = '0';

    let attempts = 0;
    let timer = null;
    const trySync = () => {
      attempts += 1;
      queryAutomationState().then((state) => {
        // Allow false->true transitions after initial page load, but avoid
        // clobbering a known-true session during transient background checks.
        automationEnabled = state.enabled;
        captionSettings = state.captionSettings;
        maximizeEnabled = state.maximizeEnabled;

        applyCaptionSettings(video);
        const captionsApplied = areCaptionsApplied(video);
        if (!isCaptionUiSynced(video) && captionsApplied) {
          markCaptionUiSynced(video);
        } else if (!isCaptionUiSynced(video) || !captionsApplied) {
          const uiAttempts = Number(video.dataset.streamChannelCaptionUiAttempts || '0');
          if (uiAttempts < 8) {
            video.dataset.streamChannelCaptionUiAttempts = String(uiAttempts + 1);
            applyCaptionSettingsViaUi();
            applyCaptionSettings(video);
          } else if (captionsApplied) {
            markCaptionUiSynced(video);
          }
        }
        applyMaximizeViaUi(video);
        const captionsDone = (areCaptionsApplied(video) || areCaptionsAppliedInUi()) && isCaptionUiSynced(video);
        const maximizeDone = !maximizeEnabled ||
          isMaximizedInUi() ||
          video.dataset.streamChannelMaximizeSettled === '1';
        if ((captionsDone && maximizeDone) || attempts >= 60) {
          if (timer) clearInterval(timer);
          video.dataset.streamChannelSyncInFlight = '0';
        }
      }).catch(() => {
        if (attempts >= 60) {
          if (timer) clearInterval(timer);
          video.dataset.streamChannelSyncInFlight = '0';
        }
      });
    };

    trySync();
    timer = setInterval(trySync, 500);
  }

  function autoClick(selectors, maxMs = 15000) {
    const started = Date.now();
    const timer = setInterval(() => {
      const button = document.querySelector(selectors.join(', '));
      if (button) {
        clearInterval(timer);
        button.click();
        return;
      }
      if (Date.now() - started > maxMs) {
        clearInterval(timer);
      }
    }, 500);
  }

  function forceStartFromBeginning(video) {
    if (!video || video.dataset.streamChannelRestarted === '1') return;
    video.dataset.streamChannelRestarted = '1';

    // One-shot restart attempt to avoid repeatedly seeking.
    const tryRestartOnce = () => {
      setTimeout(() => {
        try {
          if (video.currentTime > 1) {
            video.currentTime = 0;
          }
        } catch (_) {}
      }, 1200);
    };

    video.addEventListener('playing', tryRestartOnce, { once: true });
  }

  function bindVideoEnd() {
    if (videoEndObserverBound) return;
    videoEndObserverBound = true;
    const root = document.documentElement || document.body;
    const attach = () => {
      const video = document.querySelector('video');
      if (!video || video.dataset.streamChannelBound === '1') return;
      video.dataset.streamChannelBound = '1';
      syncCaptions(video);
      forceStartFromBeginning(video);
      if (video.dataset.streamChannelAdvanceBound === '1') return;
      video.dataset.streamChannelAdvanceBound = '1';

      const resetAdvanceState = () => {
        video.dataset.streamChannelEndedSent = '0';
        video.dataset.streamChannelLastSrc = String(video.currentSrc || video.src || '');
      };

      const sourceChanged = () => {
        const currentSrc = String(video.currentSrc || video.src || '');
        return currentSrc && currentSrc !== String(video.dataset.streamChannelLastSrc || '');
      };

      const notifyEnded = () => {
        if (video.dataset.streamChannelEndedSent === '1' || !automationEnabled) return;
        video.dataset.streamChannelEndedSent = '1';
        chrome.runtime.sendMessage({ type: 'episodeEnded' });
      };

      const onTimeUpdate = () => {
        if (sourceChanged()) resetAdvanceState();
        if (video.dataset.streamChannelEndedSent === '1' || !automationEnabled) return;
        const duration = Number(video.duration || 0);
        const current = Number(video.currentTime || 0);
        if (duration > 0 && duration - current <= 1) {
          notifyEnded();
        }
      };

      resetAdvanceState();
      video.addEventListener('loadstart', resetAdvanceState);
      video.addEventListener('loadedmetadata', resetAdvanceState);
      video.addEventListener('playing', () => {
        if (sourceChanged()) resetAdvanceState();
      });
      video.addEventListener('ended', notifyEnded);
      video.addEventListener('timeupdate', onTimeUpdate);
    };

    attach();
    const observer = new MutationObserver(attach);
    observer.observe(root, { childList: true, subtree: true });
  }

  async function handleRouteChange() {
    if (!(await shouldAutomateHere())) return;

    const href = window.location.href;
    const lower = href.toLowerCase();
    const isPlayer = lower.includes('/video/watch/') || lower.includes('/player');
    const isSeries = lower.includes('/show/') || lower.includes('/series/');
    if (href === lastHandledHref) {
      if (isPlayer) {
        bindVideoEnd();
        syncCaptions(document.querySelector('video'));
      }
      return;
    }
    lastHandledHref = href;

    if (isPlayer) {
      bindVideoEnd();
      syncCaptions(document.querySelector('video'));
    } else if (isSeries) {
      autoClick([
        'button[data-testid="play-button-hero"]',
        'button[data-testid*="play"]',
        'button[aria-label*="Play"]'
      ]);
    }
  }

  handleRouteChange().catch(() => {});
  setInterval(() => {
    handleRouteChange().catch(() => {});
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
