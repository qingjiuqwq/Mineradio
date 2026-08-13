'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  normalizeSystemMediaAction,
  normalizeSystemMediaSnapshot,
  parseSystemMediaPowerShellOutput,
  systemMediaPowerShellScript,
} = require('../desktop/system-media-session');

const appRoot = path.resolve(__dirname, '..');

function testPowerShellOutputParsing() {
  const parsed = parseSystemMediaPowerShellOutput(JSON.stringify({
    ok: true,
    action: 'next',
    controlOk: true,
    count: 1,
    current: {
      sourceAppId: 'SodaMusic',
      playbackStatus: 'Playing',
      title: 'Daily Song',
      artist: 'Daily Artist',
      albumTitle: 'Daily Album',
      positionMs: 1200,
      durationMs: 180000,
      isCurrent: true,
      score: 72,
    },
    sessions: [],
    checkedAt: 123,
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, 'next');
  assert.equal(parsed.controlOk, true);
  assert.equal(parsed.current.title, 'Daily Song');
  assert.equal(parsed.current.artist, 'Daily Artist');
  assert.equal(parsed.current.playbackStatus, 'playing');
  assert.equal(parsed.current.durationMs, 180000);
  assert.equal(parsed.checkedAt, 123);

  const invalid = parseSystemMediaPowerShellOutput('not json');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'SYSTEM_MEDIA_INVALID_JSON');
}

function testSnapshotNormalization() {
  const normalized = normalizeSystemMediaSnapshot({
    current: {
      title: '  A   B  ',
      artist: 'Artist',
      playbackStatus: 'Paused',
      positionMs: 200000,
      durationMs: 100000,
      genres: ['pop', '', 'rock'],
    },
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.current.title, 'A B');
  assert.equal(normalized.current.playbackStatus, 'paused');
  assert.equal(normalized.current.positionMs, 100000);
  assert.deepEqual(normalized.current.genres, ['pop', 'rock']);
}

function testWiring() {
  const main = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const html = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const loader = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
  const home = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '03a-home-dashboard.js'), 'utf8');
  const controls = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js'), 'utf8');
  const mainLoop = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '11-main-loop.js'), 'utf8');
  const beatRuntime = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '01-scene', '02-beat-camera-runtime.js'), 'utf8');
  const progress = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '04-progress-seek.js'), 'utf8');
  const stageLyrics = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js'), 'utf8');
  const detailLyrics = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '06-track-detail-lyrics-actions.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '07a-system-media-session.js'), 'utf8');

  assert.match(main, /require\('\.\/system-media-session'\)/);
  assert.match(main, /ipcMain\.handle\('mineradio-system-media-current'/);
  assert.match(main, /ipcMain\.handle\('mineradio-system-audio-capture-source'/);
  assert.match(main, /desktopCapturer\.getSources/);
  assert.match(main, /audio: 'loopback'/);
  assert.match(main, /function createSystemAudioCaptureGrant/);
  assert.match(main, /function isTrustedSystemAudioCapturePermission/);
  assert.match(main, /playPause\|play\|pause\|next\|previous\|seek/);
  assert.match(main, /seekMs/);
  assert.match(preload, /getSystemMediaSession/);
  assert.match(preload, /getSystemAudioCaptureSource/);
  assert.match(html, /id="system-media-btn"/);
  assert.match(html, /toggleSystemMediaMode\(\)/);
  assert.match(loader, /05-playback\/07-search\.js[\s\S]*05-playback\/07a-system-media-session\.js[\s\S]*05-playback\/08-audio-graph-controls\.js/);
  assert.match(renderer, /function readSystemCurrentMedia/);
  assert.match(renderer, /function searchSystemCurrentMedia/);
  assert.match(renderer, /function toggleSystemMediaMode/);
  assert.match(renderer, /function systemMediaControl/);
  assert.match(renderer, /function systemMediaSeek/);
  assert.match(renderer, /function systemMediaStartAudioCapture/);
  assert.match(renderer, /function systemMediaStopAudioCapture/);
  assert.match(renderer, /function systemMediaRequestAudioCaptureStream/);
  assert.match(renderer, /getDisplayMedia/);
  assert.match(renderer, /chromeMediaSource: 'desktop'/);
  assert.match(renderer, /__mineradioSystemAudioCapture/);
  assert.match(renderer, /systemMediaApplySnapshot/);
  assert.match(renderer, /function systemMediaPrepareVisualSong/);
  assert.match(renderer, /systemMediaResolveVisualSong/);
  assert.match(renderer, /resetLyricsForTrackSwitch/);
  assert.match(renderer, /fetchLyric/);
  assert.match(renderer, /applyCoverDataUrl|loadCoverFromUrl/);
  assert.match(renderer, /playbackMode: 'external-session'/);
  assert.match(controls, /systemMediaControl\('playPause'\)/);
  assert.match(controls, /systemMediaControl\('next'\)/);
  assert.match(controls, /systemMediaControl\('previous'\)/);
  assert.match(mainLoop, /systemMediaRenderProgress/);
  assert.match(mainLoop, /__mineradioSystemAudioCapture/);
  assert.match(beatRuntime, /systemMediaModeEnabled/);
  assert.match(beatRuntime, /getPlaybackCurrentSeconds/);
  assert.match(progress, /systemMediaDisplaySeconds/);
  assert.match(progress, /systemMediaSeek/);
  assert.match(progress, /externalSystemMedia/);
  assert.match(stageLyrics, /externalSystemMedia/);
  assert.match(stageLyrics, /systemMediaDisplaySeconds/);
  assert.match(detailLyrics, /systemMediaCurrentSong/);
  assert.match(home, /homeDashboardSystemMediaSummary/);
  assert.match(home, /searchSystemCurrentMedia\(\{ mode: 'song' \}\)/);
}

function testPowerShellContract() {
  const script = systemMediaPowerShellScript('next');
  assert.match(script, /GlobalSystemMediaTransportControlsSessionManager/);
  assert.match(script, /UTF8Encoding/);
  assert.match(script, /Console\]::OutputEncoding/);
  assert.match(script, /TryGetMediaPropertiesAsync/);
  assert.match(script, /GetTimelineProperties/);
  assert.match(script, /TrySkipNextAsync/);
  assert.match(script, /TryChangePlaybackPositionAsync/);
  assert.match(script, /\$Action = 'next'/);
  assert.match(script, /SourceAppUserModelId/);
}

function testActionNormalization() {
  assert.equal(normalizeSystemMediaAction('playPause'), 'playPause');
  assert.equal(normalizeSystemMediaAction('bad; Remove-Item'), 'snapshot');
}

testPowerShellOutputParsing();
testSnapshotNormalization();
testWiring();
testPowerShellContract();
testActionNormalization();

console.log('[OK] Windows system media session bridge parses GSMTC metadata and is wired into Electron.');
