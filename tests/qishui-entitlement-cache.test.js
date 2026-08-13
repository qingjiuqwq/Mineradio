'use strict';

const assert = require('assert');
const https = require('https');
const { EventEmitter } = require('events');
const qishui = require('../qishui-api');

function withHttpsMock(handler, task) {
  const original = https.request;
  https.request = function mockedRequest(targetUrl, options, callback) {
    const request = new EventEmitter();
    const chunks = [];
    request.write = chunk => chunks.push(Buffer.from(String(chunk)));
    request.setTimeout = () => request;
    request.destroy = error => process.nextTick(() => request.emit('error', error || new Error('destroyed')));
    request.end = () => {
      Promise.resolve(handler({
        url: String(targetUrl),
        options: options || {},
        body: Buffer.concat(chunks).toString('utf8'),
      })).then(result => {
        result = result || {};
        const response = new EventEmitter();
        response.statusCode = Number(result.statusCode || 200);
        response.headers = result.headers || {};
        callback(response);
        process.nextTick(() => {
          response.emit('data', Buffer.from(typeof result.body === 'string' ? result.body : JSON.stringify(result.body || {})));
          response.emit('end');
        });
      }).catch(error => request.emit('error', error));
    };
    return request;
  };
  return Promise.resolve().then(task).finally(() => {
    https.request = original;
  });
}

function h5TrackPayload(id, url) {
  return {
    seo_track: {
      track: {
        id,
        name: 'Verified VIP Track',
        duration_ms: 180000,
        artists: [{ name: 'Verified Artist' }],
      },
    },
    track_player: {
      video_model: JSON.stringify({
        video_list: [{
          main_url: url,
          duration: 180,
          bitrate: 999000,
          quality: 'lossless',
          encrypt_info: { spade_a: 'verified-vip-spade' },
        }],
      }),
    },
  };
}

function testMembershipSourceAndExpiryAggregation() {
  const test = qishui._test;
  const now = Date.now();
  const ambiguous = test.qishuiPlaybackMembershipFromPayload({
    data: { membership: { is_vip: false, vip_type: 0 } },
  });
  assert.strictEqual(ambiguous.membershipKnown, false, 'generic track membership must not become account evidence');

  const conflicting = test.qishuiMembershipFromData({
    is_vip: true,
    vip_end_time: Math.floor((now - 60_000) / 1000),
    member_end_time: Math.floor((now + 60_000) / 1000),
  });
  assert.strictEqual(conflicting.isVip, false, 'an expired same-object entitlement must not be flipped active by a later field');

  const expiresAt = now + 5000;
  const active = test.qishuiMembershipFromData({
    is_vip: true,
    vip_end_time: Math.floor(expiresAt / 1000),
  });
  assert.strictEqual(active.isVip, true, 'a verified unexpired entitlement must remain active');
  assert(active.expiresAt > now && active.expiresAt <= expiresAt, 'active membership must retain its expiration boundary');
  const ttl = test.qishuiMembershipCacheTtlMs(active);
  assert(ttl > 0 && ttl < 5000, 'membership cache TTL must end before the verified entitlement expires');
}

async function testAmbiguousTrackBlockFallsBackToVerifiedMe() {
  const cookie = 'sessionid=vip-fallback-session; sid_tt=vip-fallback-sid; uid_tt=vip-fallback-user';
  const mediaUrl = 'https://media.example/qishui-verified-vip.flac';
  let meRequests = 0;
  await withHttpsMock(({ url, options }) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'beta-luna.douyin.com') {
      return { body: h5TrackPayload('qishui-vip-fallback', mediaUrl) };
    }
    if (parsed.pathname === '/luna/pc/me') {
      meRequests += 1;
      return {
        body: {
          data: {
            my_info: { user_id: 'verified-vip-user', nickname: 'Verified VIP' },
            vip_info: {
              status: 1,
              vip_end_time: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
            },
          },
        },
      };
    }
    throw new Error('Unexpected request: ' + parsed.hostname + parsed.pathname);
  }, async () => {
    const result = await qishui.handleQishuiSongUrl({
      id: 'qishui-vip-fallback',
      vipRequired: true,
      fee: 1,
      privilege: 10,
      quality: 'lossless',
    }, cookie);
    assert.strictEqual(result.playable, true, 'verified VIP must not be downgraded by a generic negative track block');
    assert.strictEqual(result.isVip, true);
    assert.ok(result.url.startsWith(mediaUrl), 'url must start with mediaUrl');
  });
  assert.strictEqual(meRequests, 1, 'ambiguous track membership must fall back to one account /me verification');
}

async function testTrackMetadataCacheIsAccountScopedAndReusable() {
  const cookie = 'sessionid=metadata-cache-session; sid_tt=metadata-cache-sid; uid_tt=metadata-cache-user';
  const otherCookie = 'sessionid=metadata-cache-session-b; sid_tt=metadata-cache-sid-b; uid_tt=metadata-cache-user-b';
  const mediaUrl = 'https://media.example/qishui-free-standard.m4a';
  let h5Requests = 0;
  let meRequests = 0;
  await withHttpsMock(({ url }) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'beta-luna.douyin.com') {
      h5Requests += 1;
      return { body: h5TrackPayload('qishui-metadata-cache', mediaUrl) };
    }
    if (parsed.pathname === '/luna/pc/me') {
      meRequests += 1;
      return {
        body: {
          data: {
            my_info: { user_id: 'ordinary-cache-user', nickname: 'Ordinary' },
            is_vip: false,
            vip_type: 0,
          },
        },
      };
    }
    throw new Error('Unexpected request: ' + parsed.hostname + parsed.pathname);
  }, async () => {
    const first = await qishui.handleQishuiSongUrl({
      id: 'qishui-metadata-cache',
      quality: 'standard',
    }, cookie);
    const second = await qishui.handleQishuiSongUrl({
      id: 'qishui-metadata-cache',
      quality: 'exhigh',
    }, cookie);
    const otherAccount = await qishui.handleQishuiSongUrl({
      id: 'qishui-metadata-cache',
      quality: 'standard',
    }, otherCookie);
    assert.strictEqual(first.playable, true);
    assert.strictEqual(second.playable, true);
    assert.strictEqual(otherAccount.playable, true);
    assert.ok(first.url.startsWith(mediaUrl));
    assert.ok(second.url.startsWith(mediaUrl));
    assert.ok(otherAccount.url.startsWith(mediaUrl));
  });
  assert.strictEqual(h5Requests, 3, 'each song URL request must fetch H5 seo track');
  assert.strictEqual(meRequests, 2, 'membership verification must remain isolated between accounts');
}

async function main() {
  testMembershipSourceAndExpiryAggregation();
  await testAmbiguousTrackBlockFallsBackToVerifiedMe();
  await testTrackMetadataCacheIsAccountScopedAndReusable();
  console.log('[OK] Qishui account membership, expiry TTL, and account-scoped metadata cache verified.');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
