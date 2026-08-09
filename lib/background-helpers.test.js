import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeRegex,
  ruleIdFor,
  makeGrant,
  recentStatsFor,
  isGrantStale,
  isLongFormEngaged,
  getBanditFor,
} from './background-helpers.js';

function storeWith(banditState, settingsOverrides = {}) {
  return {
    banditState,
    settings: {
      alpha: 1.0,
      discountFactor: 0.99,
      armDurationsMin: [0, 5, 15, 30],
      ...settingsOverrides,
    },
  };
}

test('getBanditFor constructs a fresh bandit for a hostname with no saved state', () => {
  const bandit = getBanditFor(storeWith({}), 'example.com');
  assert.equal(bandit.arms.length, 4);
  assert.equal(bandit.alpha, 1.0);
  assert.equal(bandit.gamma, 0.99);
});

test('getBanditFor restores saved state and applies the current alpha/gamma settings', () => {
  const fresh = getBanditFor(storeWith({}), 'example.com');
  fresh.update(0, [1, 0, 0, 0, 0, 0, 0], 0.5);
  const saved = { 'example.com': fresh.toJSON() };

  const restored = getBanditFor(storeWith(saved, { alpha: 2.0, discountFactor: 0.9 }), 'example.com');
  assert.equal(restored.alpha, 2.0, 'current settings override whatever alpha was saved');
  assert.equal(restored.gamma, 0.9);
  assert.equal(
    JSON.stringify(restored.arms[0].toJSON()),
    JSON.stringify(fresh.arms[0].toJSON()),
    'the actual learned A/b state carries over'
  );
});

test('getBanditFor starts fresh if the saved arm count no longer matches current settings', () => {
  const saved = { 'example.com': { d: 7, alpha: 1, gamma: 1, arms: [{ A: [[1]], b: [1] }] } }; // 1 arm saved
  const bandit = getBanditFor(storeWith(saved, { armDurationsMin: [0, 5, 15, 30] }), 'example.com'); // 4 arms now
  assert.equal(bandit.arms.length, 4);
});

test('escapeRegex escapes every regex metacharacter', () => {
  assert.equal(escapeRegex('a.b+c*d'), 'a\\.b\\+c\\*d');
  assert.equal(escapeRegex('plain-hostname'), 'plain-hostname');
});

test('ruleIdFor assigns the next id and records it for a new hostname', async () => {
  const ruleIds = {};
  const result = await ruleIdFor('example.com', ruleIds, 5);
  assert.equal(result.id, 5);
  assert.equal(result.nextRuleId, 6);
  assert.equal(ruleIds['example.com'], 5);
});

test('ruleIdFor reuses the existing id for an already-known hostname', async () => {
  const ruleIds = { 'example.com': 3 };
  const result = await ruleIdFor('example.com', ruleIds, 9);
  assert.equal(result.id, 3);
  assert.equal(result.nextRuleId, 9, 'nextRuleId is untouched when reusing an id');
});

test('makeGrant computes expiresAt from durationMin and zeroes activeSeconds', () => {
  const now = 1_000_000;
  const grant = makeGrant(2, 15, [1, 0, 0, 0, 0, 0, 0], now, 'https://example.com/page');
  assert.equal(grant.armIndex, 2);
  assert.equal(grant.durationMin, 15);
  assert.equal(grant.grantedAt, now);
  assert.equal(grant.expiresAt, now + 15 * 60 * 1000);
  assert.equal(grant.activeSeconds, 0);
  assert.equal(grant.targetUrl, 'https://example.com/page');
});

test('makeGrant merges extra fields onto the grant', () => {
  const grant = makeGrant(0, 5, [1], 0, 'https://example.com/', { overridden: true });
  assert.equal(grant.overridden, true);
});

test('recentStatsFor counts sessions within the last 24h for the given hostname only', () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const sessions = [
    { hostname: 'a.com', grantedAt: now - 60 * 60 * 1000, decision: 'grant' },
    { hostname: 'a.com', grantedAt: now - 25 * 60 * 60 * 1000, decision: 'grant' }, // outside 24h
    { hostname: 'b.com', grantedAt: now - 60 * 60 * 1000, decision: 'grant' }, // different host
  ];
  const stats = recentStatsFor(sessions, 'a.com', now);
  assert.equal(stats.sessionsLast24h, 1);
});

test('recentStatsFor only counts grants within the frequency window, not denials or older sessions', () => {
  const now = 1_000_000_000;
  const sessions = [
    { hostname: 'a.com', grantedAt: now - 5 * 60 * 1000, decision: 'grant' },
    { hostname: 'a.com', grantedAt: now - 5 * 60 * 1000, decision: 'deny' },
    { hostname: 'a.com', grantedAt: now - 60 * 60 * 1000, decision: 'grant' }, // outside a 30-min window
  ];
  const stats = recentStatsFor(sessions, 'a.com', now, 30);
  assert.equal(stats.sessionsInFrequencyWindow, 1);
});

test('recentStatsFor counts overrides within the override window', () => {
  const now = 1_000_000_000;
  const sessions = [
    { hostname: 'a.com', grantedAt: now - 10 * 60 * 1000, overridden: true },
    { hostname: 'a.com', grantedAt: now - 300 * 60 * 1000, overridden: true }, // outside the window
    { hostname: 'a.com', grantedAt: now - 10 * 60 * 1000, overridden: false },
  ];
  const stats = recentStatsFor(sessions, 'a.com', now, 0, 240);
  assert.equal(stats.overridesInWindow, 1);
});

test('recentStatsFor averages activeMinutes over at most the last 5 sessions', () => {
  const now = 1_000_000_000;
  const sessions = [
    { hostname: 'a.com', grantedAt: now, activeMinutes: 100 }, // dropped, only last 5 count
    { hostname: 'a.com', grantedAt: now, activeMinutes: 2 },
    { hostname: 'a.com', grantedAt: now, activeMinutes: 4 },
    { hostname: 'a.com', grantedAt: now, activeMinutes: 6 },
    { hostname: 'a.com', grantedAt: now, activeMinutes: 8 },
    { hostname: 'a.com', grantedAt: now, activeMinutes: 10 },
  ];
  const stats = recentStatsFor(sessions, 'a.com', now);
  assert.equal(stats.avgRecentActiveMin, (2 + 4 + 6 + 8 + 10) / 5);
});

test('recentStatsFor returns zeroed stats for a hostname with no history', () => {
  const stats = recentStatsFor([], 'nobody.com', Date.now());
  assert.deepEqual(stats, {
    sessionsLast24h: 0,
    avgRecentActiveMin: 0,
    sessionsInFrequencyWindow: 0,
    overridesInWindow: 0,
  });
});

test('isGrantStale is false for a grant discovered right around its expiry', () => {
  const grant = { expiresAt: 1_000_000 };
  assert.equal(isGrantStale(grant, 1_000_000, 5), false); // exactly on time
  assert.equal(isGrantStale(grant, 1_000_000 + 60_000, 5), false); // 1 min late, within threshold
});

test('isGrantStale is true once a grant is found well past its expiry', () => {
  const grant = { expiresAt: 1_000_000 };
  const sixMinLate = 1_000_000 + 6 * 60 * 1000;
  assert.equal(isGrantStale(grant, sixMinLate, 5), true);
});

test('isLongFormEngaged caps the dwell requirement at the grant duration, not just the absolute floor', () => {
  // A 5-minute grant, fully used, against the default 8-minute floor: the
  // absolute floor alone would make this arm structurally unable to ever
  // qualify, no matter how attentively it was watched.
  assert.equal(isLongFormEngaged(5 * 60, 5, 8), true);
  assert.equal(isLongFormEngaged(4 * 60 + 59, 5, 8), false, 'not yet fully used');
});

test('isLongFormEngaged is unaffected for arms already longer than the dwell floor', () => {
  // A 30-minute grant still needs the full 8 minutes, same as before this
  // fix - only arms shorter than the floor get a different threshold.
  assert.equal(isLongFormEngaged(7 * 60 + 59, 30, 8), false);
  assert.equal(isLongFormEngaged(8 * 60, 30, 8), true);
});
