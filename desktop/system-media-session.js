'use strict';

const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 4500;

function clampText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizePlaybackStatus(value) {
  const raw = clampText(value, 40);
  const lower = raw.toLowerCase();
  if (lower === 'playing') return 'playing';
  if (lower === 'paused') return 'paused';
  if (lower === 'stopped') return 'stopped';
  if (lower === 'closed') return 'closed';
  if (lower === 'changing') return 'changing';
  return raw || 'unknown';
}

function normalizeSessionItem(item) {
  item = item && typeof item === 'object' ? item : {};
  const durationMs = Math.max(0, Number(item.durationMs) || 0);
  const positionMs = Math.max(0, Math.min(durationMs || Number.MAX_SAFE_INTEGER, Number(item.positionMs) || 0));
  const lastUpdatedTimeMs = Math.max(0, Number(item.lastUpdatedTimeMs) || 0);
  return {
    sourceAppId: clampText(item.sourceAppId, 160),
    playbackStatus: normalizePlaybackStatus(item.playbackStatus),
    title: clampText(item.title, 300),
    artist: clampText(item.artist, 300),
    albumTitle: clampText(item.albumTitle, 300),
    albumArtist: clampText(item.albumArtist, 300),
    trackNumber: Math.max(0, Number(item.trackNumber) || 0),
    genres: Array.isArray(item.genres) ? item.genres.map(value => clampText(value, 80)).filter(Boolean).slice(0, 8) : [],
    positionMs,
    durationMs,
    minSeekTimeMs: Math.max(0, Number(item.minSeekTimeMs) || 0),
    maxSeekTimeMs: Math.max(0, Number(item.maxSeekTimeMs) || 0),
    lastUpdatedTime: clampText(item.lastUpdatedTime, 80),
    lastUpdatedTimeMs,
    isCurrent: item.isCurrent === true,
    score: Number(item.score) || 0,
  };
}

function normalizeSystemMediaSnapshot(payload) {
  payload = payload && typeof payload === 'object' ? payload : {};
  const sessions = Array.isArray(payload.sessions) ? payload.sessions.map(normalizeSessionItem) : [];
  const current = payload.current ? normalizeSessionItem(payload.current) : null;
  return {
    ok: payload.ok !== false,
    supported: payload.supported !== false,
    count: Math.max(0, Number(payload.count) || sessions.length),
    action: clampText(payload.action, 40),
    controlOk: typeof payload.controlOk === 'boolean' ? payload.controlOk : null,
    current,
    sessions,
    error: clampText(payload.error, 300),
    checkedAt: Number(payload.checkedAt) || Date.now(),
  };
}

function parseSystemMediaPowerShellOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return normalizeSystemMediaSnapshot({ ok: true, current: null, sessions: [] });
  try {
    return normalizeSystemMediaSnapshot(JSON.parse(text));
  } catch (error) {
    return normalizeSystemMediaSnapshot({
      ok: false,
      supported: true,
      error: 'SYSTEM_MEDIA_INVALID_JSON',
      raw: text.slice(0, 500),
    });
  }
}

function normalizeSystemMediaAction(action) {
  action = String(action || 'snapshot');
  return /^(snapshot|playPause|play|pause|next|previous|seek)$/.test(action) ? action : 'snapshot';
}

function systemMediaPowerShellScript(action, seekMs) {
  const safeAction = normalizeSystemMediaAction(action);
  const safeSeekMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(seekMs) || 0));
  return String.raw`
$ErrorActionPreference = 'Stop'
$Action = '${safeAction}'
$SeekMs = [int64]${Math.round(safeSeekMs)}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]

function Await-WinRtOperation($operation, [Type]$resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1'
  } | Select-Object -First 1
  if ($null -eq $method) { throw 'WINRT_ASTASK_MISSING' }
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait() | Out-Null
  return $task.Result
}

function Ms($span) {
  if ($null -eq $span) { return 0 }
  return [int64][Math]::Max(0, $span.TotalMilliseconds)
}

function SafeText($value) {
  if ($null -eq $value) { return '' }
  return [string]$value
}

function SafeStatus($session) {
  try { return [string]$session.GetPlaybackInfo().PlaybackStatus } catch { return 'Unknown' }
}

function SafeTimeline($session) {
  try { return $session.GetTimelineProperties() } catch { return $null }
}

function TimelineDurationMs($timeline) {
  if ($null -eq $timeline) { return 0 }
  $endTimeMs = Ms $timeline.EndTime
  $maxSeekTimeMs = Ms $timeline.MaxSeekTime
  $endRangeMs = [int64][Math]::Max(0, ($timeline.EndTime - $timeline.StartTime).TotalMilliseconds)
  $seekRangeMs = [int64][Math]::Max(0, ($timeline.MaxSeekTime - $timeline.MinSeekTime).TotalMilliseconds)
  return [int64][Math]::Max([Math]::Max($endTimeMs, $maxSeekTimeMs), [Math]::Max($endRangeMs, $seekRangeMs))
}

function TimelineLastUpdatedMs($timeline) {
  if ($null -eq $timeline -or $null -eq $timeline.LastUpdatedTime) { return 0 }
  try { return [DateTimeOffset]$timeline.LastUpdatedTime.ToUnixTimeMilliseconds() } catch {}
  try { return ([DateTimeOffset]$timeline.LastUpdatedTime).ToUnixTimeMilliseconds() } catch {}
  return 0
}

function ProjectedPositionMs($timeline, $status, $durationMs, $nowMs) {
  if ($null -eq $timeline) { return 0 }
  $positionMs = Ms $timeline.Position
  $lastUpdatedMs = TimelineLastUpdatedMs $timeline
  if ($status -eq 'Playing' -and $lastUpdatedMs -gt 0 -and $nowMs -gt $lastUpdatedMs) {
    $positionMs += [int64]($nowMs - $lastUpdatedMs)
  }
  if ($durationMs -gt 0) { return [int64][Math]::Min($durationMs, [Math]::Max(0, $positionMs)) }
  return [int64][Math]::Max(0, $positionMs)
}

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$mediaType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$manager = Await-WinRtOperation ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) $managerType
$currentSession = $manager.GetCurrentSession()
$items = @()
$checkedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

foreach ($session in $manager.GetSessions()) {
  $sourceAppId = ''
  try { $sourceAppId = [string]$session.SourceAppUserModelId } catch {}
  $status = SafeStatus $session
  $timeline = SafeTimeline $session
  $media = $null
  try { $media = Await-WinRtOperation ($session.TryGetMediaPropertiesAsync()) $mediaType } catch {}

  $title = if ($media) { SafeText $media.Title } else { '' }
  $artist = if ($media -and -not [string]::IsNullOrWhiteSpace($media.Artist)) { SafeText $media.Artist } elseif ($media) { SafeText $media.AlbumArtist } else { '' }
  $durationMs = TimelineDurationMs $timeline
  $lastUpdatedMs = TimelineLastUpdatedMs $timeline
  $positionMs = ProjectedPositionMs $timeline $status $durationMs $checkedAtMs
  $score = 0
  if ($session -eq $currentSession) { $score += 12 }
  if ($status -eq 'Playing') { $score += 20 }
  if (-not [string]::IsNullOrWhiteSpace($title)) { $score += 14 }
  if (-not [string]::IsNullOrWhiteSpace($artist)) { $score += 8 }
  if ($durationMs -gt 1000) { $score += 18 } else { $score -= 10 }
  if ($sourceAppId.ToLowerInvariant().Contains('cloudmusicreport')) { $score -= 24 }

  $items += [pscustomobject]@{
    score = $score
    sourceAppId = $sourceAppId
    playbackStatus = $status
    title = $title
    artist = $artist
    albumTitle = if ($media) { SafeText $media.AlbumTitle } else { '' }
    albumArtist = if ($media) { SafeText $media.AlbumArtist } else { '' }
    trackNumber = if ($media) { [int]$media.TrackNumber } else { 0 }
    genres = if ($media -and $media.Genres) { @($media.Genres | ForEach-Object { SafeText $_ }) } else { @() }
    positionMs = $positionMs
    durationMs = $durationMs
    minSeekTimeMs = if ($timeline) { Ms $timeline.MinSeekTime } else { 0 }
    maxSeekTimeMs = if ($timeline) { Ms $timeline.MaxSeekTime } else { 0 }
    lastUpdatedTime = if ($timeline -and $timeline.LastUpdatedTime) { SafeText $timeline.LastUpdatedTime } else { '' }
    lastUpdatedTimeMs = $lastUpdatedMs
    isCurrent = ($session -eq $currentSession)
  }
}

$best = $items | Sort-Object -Property score -Descending | Select-Object -First 1

if ($Action -and $Action -ne 'snapshot') {
  $targetSession = $null
  $targetScore = [int]::MinValue
  foreach ($session in $manager.GetSessions()) {
    $sourceAppId = ''
    try { $sourceAppId = [string]$session.SourceAppUserModelId } catch {}
    $status = SafeStatus $session
    $timeline = SafeTimeline $session
    $media = $null
    try { $media = Await-WinRtOperation ($session.TryGetMediaPropertiesAsync()) $mediaType } catch {}
    $title = if ($media) { SafeText $media.Title } else { '' }
    $artist = if ($media -and -not [string]::IsNullOrWhiteSpace($media.Artist)) { SafeText $media.Artist } elseif ($media) { SafeText $media.AlbumArtist } else { '' }
    $durationMs = TimelineDurationMs $timeline
    $score = 0
    if ($session -eq $currentSession) { $score += 12 }
    if ($status -eq 'Playing') { $score += 20 }
    if (-not [string]::IsNullOrWhiteSpace($title)) { $score += 14 }
    if (-not [string]::IsNullOrWhiteSpace($artist)) { $score += 8 }
    if ($durationMs -gt 1000) { $score += 18 } else { $score -= 10 }
    if ($sourceAppId.ToLowerInvariant().Contains('cloudmusicreport')) { $score -= 24 }
    if ($null -eq $targetSession -or $score -gt $targetScore) {
      $targetSession = $session
      $targetScore = $score
    }
  }
  $controlOk = $false
  if ($targetSession) {
    if ($Action -eq 'playPause') { $controlOk = Await-WinRtOperation ($targetSession.TryTogglePlayPauseAsync()) ([bool]) }
    elseif ($Action -eq 'play') { $controlOk = Await-WinRtOperation ($targetSession.TryPlayAsync()) ([bool]) }
    elseif ($Action -eq 'pause') { $controlOk = Await-WinRtOperation ($targetSession.TryPauseAsync()) ([bool]) }
    elseif ($Action -eq 'next') { $controlOk = Await-WinRtOperation ($targetSession.TrySkipNextAsync()) ([bool]) }
    elseif ($Action -eq 'previous') { $controlOk = Await-WinRtOperation ($targetSession.TrySkipPreviousAsync()) ([bool]) }
    elseif ($Action -eq 'seek') { $controlOk = Await-WinRtOperation ($targetSession.TryChangePlaybackPositionAsync($SeekMs * 10000)) ([bool]) }
  }
}

[pscustomobject]@{
  ok = $true
  supported = $true
  action = $Action
  controlOk = if ($Action -and $Action -ne 'snapshot') { [bool]$controlOk } else { $null }
  count = $items.Count
  current = $best
  sessions = $items
  checkedAt = $checkedAtMs
} | ConvertTo-Json -Depth 5 -Compress
`;
}

function readSystemMediaSession(options) {
  options = options || {};
  if (process.platform !== 'win32') {
    return Promise.resolve({
      ok: false,
      supported: false,
      current: null,
      sessions: [],
      count: 0,
      error: 'SYSTEM_MEDIA_WINDOWS_ONLY',
      checkedAt: Date.now(),
    });
  }
  const timeoutMs = Math.max(1000, Math.min(15000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  return new Promise((resolve) => {
    execFile('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      systemMediaPowerShellScript(options.action, options.seekMs),
    ], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        resolve(normalizeSystemMediaSnapshot({
          ok: false,
          supported: true,
          current: null,
          sessions: [],
          error: error.killed ? 'SYSTEM_MEDIA_TIMEOUT' : (stderr || error.message || 'SYSTEM_MEDIA_READ_FAILED'),
          checkedAt: Date.now(),
        }));
        return;
      }
      resolve(parseSystemMediaPowerShellOutput(stdout));
    });
  });
}

module.exports = {
  readSystemMediaSession,
  normalizeSystemMediaAction,
  normalizeSystemMediaSnapshot,
  parseSystemMediaPowerShellOutput,
  systemMediaPowerShellScript,
};
