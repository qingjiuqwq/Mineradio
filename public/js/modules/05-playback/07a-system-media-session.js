// ============================================================
//  Windows system media session bridge
var systemMediaSessionSnapshot = null;
var systemMediaSessionLastQuery = '';
var systemMediaMode = false;
var systemMediaPollTimer = 0;
var systemMediaPollBusy = false;
var systemMediaLastSong = null;
var systemMediaLastSnapshotAt = 0;
var systemMediaVisualSongKey = '';
var systemMediaVisualResolveSeq = 0;
var systemMediaVisualResolveCache = {};
var systemMediaLastProgressKey = '';
var systemMediaLastDisplaySeconds = 0;
var SYSTEM_MEDIA_MODE_STORE_KEY = 'mineradio-system-media-mode-v1';
var SYSTEM_MEDIA_POLL_MS = 1150;

function normalizeSystemMediaText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function systemMediaCurrentItem(snapshot) {
  snapshot = snapshot || systemMediaSessionSnapshot || {};
  var current = snapshot.current || null;
  if (!current || typeof current !== 'object') return null;
  var title = normalizeSystemMediaText(current.title);
  var artist = normalizeSystemMediaText(current.artist || current.albumArtist);
  if (!title && !artist) return null;
  return {
    provider: 'system-media',
    source: 'system-media',
    type: 'external',
    id: 'system-media:' + [current.sourceAppId, title, artist].join('|'),
    name: title || '系统媒体',
    title: title || '系统媒体',
    artist: artist,
    album: normalizeSystemMediaText(current.albumTitle),
    duration: Math.max(0, Number(current.durationMs) || 0) / 1000,
    progress: Math.max(0, Number(current.positionMs) || 0) / 1000,
    playbackStatus: normalizeSystemMediaText(current.playbackStatus),
    sourceAppId: normalizeSystemMediaText(current.sourceAppId),
    playable: false,
    playbackMode: 'external-session',
    recommendationSource: 'windows-gsmtc',
  };
}

function systemMediaModeEnabled() {
  return !!systemMediaMode;
}

function systemMediaCurrentSong() {
  return systemMediaLastSong || null;
}

function systemMediaPersistMode(enabled) {
  try { localStorage.setItem(SYSTEM_MEDIA_MODE_STORE_KEY, enabled ? '1' : '0'); } catch (_error) { }
}

function systemMediaReadPersistedMode() {
  try { return localStorage.getItem(SYSTEM_MEDIA_MODE_STORE_KEY) === '1'; } catch (_error) { return false; }
}

function systemMediaButtonUpdate() {
  var btn = document.getElementById('system-media-btn');
  if (!btn) return;
  btn.classList.toggle('active', !!systemMediaMode);
  btn.setAttribute('aria-pressed', systemMediaMode ? 'true' : 'false');
  btn.title = systemMediaMode ? '停止读取系统当前播放' : '读取系统当前播放';
  document.body.classList.toggle('system-media-mode', !!systemMediaMode);
}

async function readSystemCurrentMedia(opts) {
  opts = opts || {};
  if (!window.desktopWindow || typeof window.desktopWindow.getSystemMediaSession !== 'function') {
    return { ok: false, supported: false, current: null, error: 'DESKTOP_SYSTEM_MEDIA_UNAVAILABLE' };
  }
  var snapshot = await window.desktopWindow.getSystemMediaSession({
    timeoutMs: opts.timeoutMs || 4500,
    action: opts.action || 'snapshot',
    seekMs: opts.seekMs
  });
  systemMediaSessionSnapshot = snapshot || null;
  return snapshot || { ok: false, current: null, sessions: [] };
}

function systemMediaGeneratedCover(item) {
  item = item || {};
  if (typeof homeDashboardGeneratedCover === 'function') {
    return homeDashboardGeneratedCover(item.name || item.title || 'System', item.sourceAppId || 'SYSTEM', 'search');
  }
  return '';
}

function systemMediaSongFromItem(item) {
  if (!item) return null;
  return {
    provider: 'system-media',
    source: 'system-media',
    type: 'external',
    id: item.id || ('system-media:' + [item.sourceAppId, item.name || item.title, item.artist].join('|')),
    name: item.name || item.title || '系统媒体',
    title: item.name || item.title || '系统媒体',
    artist: item.artist || item.sourceAppId || '',
    album: item.album || '',
    cover: item.cover || systemMediaGeneratedCover(item),
    duration: Number(item.duration) || 0,
    progress: Number(item.progress) || 0,
    playable: false,
    playbackMode: 'external-session',
    playbackStatus: item.playbackStatus || 'unknown',
    sourceAppId: item.sourceAppId || '',
    recommendationSource: 'windows-gsmtc',
  };
}

function systemMediaSongKey(song) {
  if (!song) return '';
  return [
    normalizeSystemMediaText(song.sourceAppId || ''),
    normalizeSystemMediaText(song.name || song.title || ''),
    normalizeSystemMediaText(song.artist || ''),
    normalizeSystemMediaText(song.album || '')
  ].join('|').toLowerCase();
}

function systemMediaSearchVisualQuery(song) {
  song = song || {};
  var artist = String(song.artist || '').split(/\s*\/\s*|\s*,\s*|\s*&\s*/)[0] || '';
  return [song.name || song.title || '', artist].filter(Boolean).join(' ').trim();
}

function systemMediaVisualCandidateScore(source, candidate, query, index) {
  if (!candidate) return -999;
  if (typeof scoreSongSearchResult === 'function') return scoreSongSearchResult(candidate, query, index);
  var score = Math.max(0, 30 - Math.max(0, Number(index) || 0));
  var sourceTitle = normalizeSystemMediaText(source && (source.name || source.title)).toLowerCase();
  var candidateTitle = normalizeSystemMediaText(candidate.name || candidate.title).toLowerCase();
  var sourceArtist = normalizeSystemMediaText(source && source.artist).toLowerCase();
  var candidateArtist = normalizeSystemMediaText(candidate.artist).toLowerCase();
  if (sourceTitle && candidateTitle && sourceTitle === candidateTitle) score += 90;
  if (sourceArtist && candidateArtist && (sourceArtist.indexOf(candidateArtist) >= 0 || candidateArtist.indexOf(sourceArtist) >= 0)) score += 55;
  return score;
}

async function systemMediaResolveVisualSong(song, key, seq) {
  if (!song || !key) return song;
  if (systemMediaVisualResolveCache[key]) return Object.assign({}, song, systemMediaVisualResolveCache[key]);
  if (typeof apiJson !== 'function') return song;
  var query = systemMediaSearchVisualQuery(song);
  if (!query) return song;
  try {
    var data = typeof fetchMusicSearchResults === 'function'
      ? await fetchMusicSearchResults(query, 'song')
      : await apiJson('/api/search?keywords=' + encodeURIComponent(query) + '&limit=8', { timeoutMs: 5200 });
    if (seq !== systemMediaVisualResolveSeq || key !== systemMediaVisualSongKey) return null;
    var list = data && (data.songs || data.result || []);
    if (!Array.isArray(list) || !list.length) return song;
    var best = null;
    var bestScore = -999;
    for (var i = 0; i < list.length; i++) {
      var candidate = list[i];
      if (typeof sourceCandidateRejectReason === 'function' && sourceCandidateRejectReason(song, candidate, 'netease')) continue;
      var score = systemMediaVisualCandidateScore(song, candidate, query, i);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best || bestScore < 32) return song;
    var resolved = Object.assign({}, best, {
      duration: song.duration || best.duration,
      progress: song.progress,
      playbackStatus: song.playbackStatus,
      playbackMode: 'external-session',
      sourceAppId: song.sourceAppId || best.sourceAppId || '',
      externalSessionId: song.id,
      playable: false
    });
    systemMediaVisualResolveCache[key] = resolved;
    return Object.assign({}, song, resolved);
  } catch (error) {
    console.warn('[SystemMediaSession] visual match failed:', error);
    return song;
  }
}

function systemMediaApplyCover(song, token, firstVisual) {
  if (!song) return;
  var customCover = typeof getCustomCoverForSong === 'function' ? getCustomCoverForSong(song) : '';
  var cover = customCover || song.cover || '';
  var coverOpts = {
    trackToken: token,
    deferHeavy: true,
    delay: firstVisual ? 240 : 120,
    timeout: firstVisual ? 1200 : 900,
    seamlessTrackSwitch: !firstVisual
  };
  if (/^data:image\//i.test(String(cover || '')) && typeof applyCoverDataUrl === 'function') {
    applyCoverDataUrl(cover, coverOpts);
  } else if (typeof loadCoverFromUrl === 'function') {
    loadCoverFromUrl(cover ? coverUrlWithSize(cover, 400) : '', coverOpts);
  } else if (typeof setControlCoverSrc === 'function') {
    setControlCoverSrc(cover || '');
  }
}

function systemMediaPrepareVisualSong(song, key) {
  if (!song || !key || key === systemMediaVisualSongKey) return;
  systemMediaVisualSongKey = key;
  var seq = ++systemMediaVisualResolveSeq;
  var token = ++trackSwitchToken;
  var firstVisual = !firstPlayDone;
  currentLocalSong = song;
  currentBeatMap = null;
  beatMapNextIdx = 0;
  beatMapToken++;
  if (typeof cancelBeatAnalysisTimer === 'function') cancelBeatAnalysisTimer();
  if (typeof resetAudioVisualState === 'function') resetAudioVisualState();
  if (typeof switchPlaybackVisualToEmily === 'function') switchPlaybackVisualToEmily();
  if (firstVisual && typeof tweenParticleAlpha === 'function' && typeof uniforms !== 'undefined' && uniforms.uAlpha) {
    firstPlayDone = true;
    tweenParticleAlpha(uniforms.uAlpha.value || 0, 1.0, 220);
  }
  if (typeof resetLyricsForTrackSwitch === 'function') resetLyricsForTrackSwitch(song, token);
  if (typeof scheduleTrackSwitchFallbackLyrics === 'function') scheduleTrackSwitchFallbackLyrics(song, token, 900);
  systemMediaApplyCover(song, token, firstVisual);
  systemMediaResolveVisualSong(song, key, seq).then(function (resolvedSong) {
    if (!resolvedSong || seq !== systemMediaVisualResolveSeq || key !== systemMediaVisualSongKey) return;
    systemMediaLastSong = resolvedSong;
    currentLocalSong = resolvedSong;
    if (typeof updateControlTrackInfo === 'function') updateControlTrackInfo(resolvedSong);
    systemMediaApplyCover(resolvedSong, token, firstVisual);
    var resolvedProvider = String(resolvedSong.provider || resolvedSong.source || '');
    if (typeof fetchLyric === 'function' && resolvedProvider !== 'system-media' && resolvedSong.id) fetchLyric(resolvedSong, token);
    if (typeof applyPreferredLyricsForCurrent === 'function') applyPreferredLyricsForCurrent(true);
    if (typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume('system-media-track');
  });
}

function systemMediaDisplaySeconds(song) {
  var base = Math.max(0, Number(song && song.progress) || 0);
  if (!song || song.playbackStatus !== 'playing' || !systemMediaLastSnapshotAt) return base;
  var elapsed = (Date.now() - systemMediaLastSnapshotAt) / 1000;
  var duration = Math.max(0, Number(song.duration) || 0);
  var current = base + Math.max(0, elapsed);
  return duration > 0 ? Math.min(duration, current) : current;
}

function systemMediaSmoothSnapshotProgress(song, key) {
  if (!song || song.playbackStatus !== 'playing') return song;
  var predicted = key && key === systemMediaLastProgressKey ? systemMediaDisplaySeconds(systemMediaLastSong) : 0;
  var incoming = Math.max(0, Number(song.progress) || 0);
  var duration = Math.max(0, Number(song.duration) || 0);
  if (predicted > 0 && incoming + 4 >= predicted && incoming < predicted) {
    song.progress = duration > 0 ? Math.min(duration, predicted) : predicted;
  }
  return song;
}

function systemMediaRenderProgress(song) {
  song = song || systemMediaLastSong;
  var duration = Math.max(0, Number(song && song.duration) || 0);
  var current = systemMediaDisplaySeconds(song);
  if (duration > 0 && current > duration) current = duration;
  if (typeof setProgressVisual === 'function') setProgressVisual(duration > 0 ? current / duration * 100 : 0);
  var timeDisplay = document.getElementById('time-display');
  if (timeDisplay && typeof formatProgramTime === 'function') {
    timeDisplay.textContent = formatProgramTime(current) + ' / ' + (duration > 0 ? formatProgramTime(duration) : '0:00');
  }
}

function systemMediaApplySnapshot(snapshot) {
  var item = systemMediaCurrentItem(snapshot);
  if (!item) {
    systemMediaLastSong = null;
    systemMediaVisualSongKey = '';
    systemMediaVisualResolveSeq++;
    if (typeof updateControlTrackInfo === 'function') updateControlTrackInfo({});
    if (typeof setPlayIcon === 'function') setPlayIcon(false);
    systemMediaRenderProgress(null);
    return false;
  }
  var song = systemMediaSongFromItem(item);
  var key = systemMediaSongKey(song);
  song = systemMediaSmoothSnapshotProgress(song, key);
  if (key && systemMediaVisualResolveCache[key]) {
    song = Object.assign({}, song, systemMediaVisualResolveCache[key], {
      duration: song.duration || systemMediaVisualResolveCache[key].duration,
      progress: song.progress,
      playbackStatus: song.playbackStatus,
      playbackMode: 'external-session',
      sourceAppId: song.sourceAppId
    });
  }
  systemMediaLastSong = song;
  systemMediaLastSnapshotAt = Date.now();
  systemMediaLastProgressKey = key;
  systemMediaLastDisplaySeconds = systemMediaDisplaySeconds(song);
  currentLocalSong = song;
  playing = song.playbackStatus === 'playing';
  if (typeof updateControlTrackInfo === 'function') updateControlTrackInfo(song);
  if (typeof setControlCoverSrc === 'function') setControlCoverSrc(song.cover || '');
  if (typeof setPlayIcon === 'function') setPlayIcon(playing);
  systemMediaPrepareVisualSong(song, key);
  systemMediaRenderProgress(song);
  if (playing && typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume('system-media-playing');
  if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility();
  return true;
}

async function systemMediaRefresh(opts) {
  opts = opts || {};
  if (!systemMediaMode || systemMediaPollBusy) return false;
  systemMediaPollBusy = true;
  try {
    var snapshot = await readSystemCurrentMedia({ timeoutMs: opts.timeoutMs || 4200, action: opts.action || 'snapshot' });
    var applied = systemMediaApplySnapshot(snapshot);
    if (!applied && opts.toast !== false && typeof showToast === 'function') showToast('没有读取到系统正在播放的歌曲');
    return applied;
  } catch (error) {
    console.warn('[SystemMediaSession]', error);
    return false;
  } finally {
    systemMediaPollBusy = false;
  }
}

function systemMediaSchedulePoll(delayMs) {
  clearTimeout(systemMediaPollTimer);
  if (!systemMediaMode) return;
  systemMediaPollTimer = setTimeout(function () {
    systemMediaRefresh({ toast: false }).finally(function () {
      systemMediaSchedulePoll(SYSTEM_MEDIA_POLL_MS);
    });
  }, Math.max(120, Number(delayMs) || SYSTEM_MEDIA_POLL_MS));
}

function setSystemMediaMode(enabled, opts) {
  opts = opts || {};
  systemMediaMode = enabled === true;
  systemMediaPersistMode(systemMediaMode);
  systemMediaButtonUpdate();
  clearTimeout(systemMediaPollTimer);
  systemMediaPollTimer = 0;
  if (systemMediaMode) {
    if (audio && !audio.paused) {
      try { audio.pause(); } catch (_error) { }
    }
    playToggleBusy = false;
    systemMediaRefresh({ toast: opts.toast !== false }).finally(function () { systemMediaSchedulePoll(260); });
  } else {
    systemMediaLastSong = null;
    systemMediaVisualSongKey = '';
    systemMediaVisualResolveSeq++;
    currentLocalSong = currentIdx >= 0 && playQueue[currentIdx] ? playQueue[currentIdx] : null;
    if (currentLocalSong && typeof updateControlTrackInfo === 'function') updateControlTrackInfo(currentLocalSong);
    if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
    if (typeof syncPlaybackStateFromAudioEvent === 'function') syncPlaybackStateFromAudioEvent('system-media-disabled');
  }
}

function toggleSystemMediaMode() {
  setSystemMediaMode(!systemMediaMode, { toast: true });
}

async function systemMediaControl(action) {
  if (!systemMediaMode) return false;
  action = String(action || 'snapshot');
  if (!/^(playPause|play|pause|next|previous)$/.test(action)) return false;
  var snapshot = await readSystemCurrentMedia({ timeoutMs: 4500, action: action });
  systemMediaApplySnapshot(snapshot);
  systemMediaSchedulePoll(420);
  return snapshot && snapshot.controlOk !== false;
}

async function systemMediaSeek(seconds) {
  if (!systemMediaMode) return false;
  var duration = Math.max(0, Number(systemMediaLastSong && systemMediaLastSong.duration) || 0);
  var target = Math.max(0, Number(seconds) || 0);
  if (duration > 0) target = Math.min(duration, target);
  if (systemMediaLastSong) {
    systemMediaLastSong.progress = target;
    systemMediaLastSnapshotAt = Date.now();
    systemMediaRenderProgress(systemMediaLastSong);
  }
  var snapshot = await readSystemCurrentMedia({ timeoutMs: 4500, action: 'seek', seekMs: Math.round(target * 1000) });
  if (snapshot && snapshot.current && snapshot.controlOk !== false) {
    snapshot.current.positionMs = Math.round(target * 1000);
    snapshot.checkedAt = Date.now();
  }
  systemMediaApplySnapshot(snapshot);
  systemMediaSchedulePoll(420);
  return snapshot && snapshot.controlOk !== false;
}

function bindSystemMediaModeStartup() {
  systemMediaMode = systemMediaReadPersistedMode();
  systemMediaButtonUpdate();
  if (systemMediaMode) systemMediaRefresh({ toast: false }).finally(function () { systemMediaSchedulePoll(480); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindSystemMediaModeStartup);
else bindSystemMediaModeStartup();

function systemMediaSearchQuery(item) {
  item = item || systemMediaCurrentItem();
  if (!item) return '';
  return [item.name || item.title, item.artist].filter(Boolean).join(' ').trim();
}

async function searchSystemCurrentMedia(opts) {
  opts = opts || {};
  var snapshot = await readSystemCurrentMedia(opts);
  var item = systemMediaCurrentItem(snapshot);
  var query = systemMediaSearchQuery(item);
  if (!query) {
    if (typeof showToast === 'function') showToast('没有读取到系统正在播放的歌曲');
    return { ok: false, item: null, query: '', snapshot: snapshot };
  }
  systemMediaSessionLastQuery = query;
  if (typeof setSearchMode === 'function') setSearchMode(opts.mode || 'song');
  if (typeof $input !== 'undefined' && $input) $input.value = query;
  if (typeof setPeek === 'function') setPeek(document.getElementById('search-area'), true, 'search');
  if (typeof doSearch === 'function') await doSearch(query, { autoPlayFirst: opts.autoPlayFirst === true });
  return { ok: true, item: item, query: query, snapshot: snapshot };
}
