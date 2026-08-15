import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeRegex,
  ruleIdFor,
  makeGrant,
  recentStatsFor,
  isGrantStale,
  getBanditFor,
  crossSiteWarmStart,
  estimateExposureMinutes,
  globalFatigueStats,
  globalFrictionCount24h,
  getFreeTimeBandit,
} from './background-helpers.js';
import { FREE_TIME_DURATIONS_MIN } from './config.js';
import { FEATURE_DIM } from './linucb.js';

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

test('getBanditFor starts fresh if the saved feature dimension no longer matches', () => {
  const badDim = { d: FEATURE_DIM + 1, alpha: 1, gamma: 1, arms: [{ A: [[1]], b: [1] }, { A: [[1]], b: [1] }, { A: [[1]], b: [1] }, { A: [[1]], b: [1] }] };
  const bandit = getBanditFor(storeWith({ 'example.com': badDim }, { armDurationsMin: [0, 5, 15, 30] }), 'example.com');
  assert.equal(bandit.d, FEATURE_DIM);
});

test('getBanditFor warm-starts a new site from other sites when crossSiteWarmStartWeight is set', () => {
  const trained = getBanditFor(storeWith({}), 'other.com');
  trained.update(1, [1, 0, 0, 0, 0, 0, 0], 0.5);
  const banditState = { 'other.com': trained.toJSON() };

  const cold = getBanditFor(storeWith(banditState, { crossSiteWarmStartWeight: 0 }), 'new.com');
  const warm = getBanditFor(storeWith(banditState, { crossSiteWarmStartWeight: 0.5 }), 'new.com');

  assert.deepEqual(warm.arms[0].toJSON(), cold.arms[0].toJSON(), 'untouched arms stay at the identity/zero baseline');
  assert.notDeepEqual(warm.arms[1].toJSON(), cold.arms[1].toJSON(), 'the arm the sibling actually learned something on differs');
});

test('crossSiteWarmStart excludes the site itself from its own average', () => {
  const self = { d: 2, arms: [{ A: [[99, 0], [0, 99]], b: [99, 99] }] };
  const arms = crossSiteWarmStart({ 'self.com': self }, 'self.com', 1, 2, 0.5);
  assert.equal(arms, null, 'no *other* sites exist, so this should fall back to cold start');
});

test('crossSiteWarmStart returns null when shrinkage is 0 even with eligible siblings', () => {
  const sibling = { d: 2, arms: [{ A: [[2, 0], [0, 2]], b: [1, 1] }] };
  const arms = crossSiteWarmStart({ 'sibling.com': sibling }, 'new.com', 1, 2, 0);
  assert.equal(arms, null);
});

test('crossSiteWarmStart ignores siblings with a mismatched arm count or feature dimension', () => {
  const wrongArms = { d: 2, arms: [{ A: [[2, 0], [0, 2]], b: [1, 1] }] }; // 1 arm, need 2
  const wrongDim = { d: 3, arms: [{ A: [[1]], b: [1] }, { A: [[1]], b: [1] }] }; // wrong d
  const arms = crossSiteWarmStart({ a: wrongArms, b: wrongDim }, 'new.com', 2, 2, 0.5);
  assert.equal(arms, null);
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

test('makeGrant starts with its one-time navigation hop unspent', () => {
  const grant = makeGrant(0, 5, [1], 0, 'https://example.com/');
  assert.equal(grant.hopUsed, false);
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

test('estimateExposureMinutes returns 0 for no visits', () => {
  assert.equal(estimateExposureMinutes([], 15), 0);
});

test('estimateExposureMinutes credits a flat minimum for a single visit', () => {
  assert.equal(estimateExposureMinutes([1_000_000], 15), 0.5);
});

test('estimateExposureMinutes sums gaps between visits, floored at the per-visit minimum', () => {
  const base = 0;
  const twoMinLater = 2 * 60 * 1000;
  const fourMinLater = 4 * 60 * 1000;
  // gaps: 2min, 2min, plus 0.5min for the final visit
  assert.equal(estimateExposureMinutes([base, twoMinLater, fourMinLater], 15), 4.5);
});

test('estimateExposureMinutes caps any single gap so a stray visit before a long silence is not counted as sustained exposure', () => {
  const base = 0;
  const oneHourLater = 60 * 60 * 1000;
  // gap is capped at 15 rather than counted as 60, plus 0.5 for the final visit
  assert.equal(estimateExposureMinutes([base, oneHourLater], 15), 15.5);
});

test('globalFatigueStats sums activeMinutes across every hostname in the last 24h', () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const sessions = [
    { hostname: 'a.com', grantedAt: dayAgo + 1000, activeMinutes: 10 },
    { hostname: 'b.com', grantedAt: dayAgo + 2000, activeMinutes: 5 },
    { hostname: 'a.com', grantedAt: dayAgo - 1000, activeMinutes: 999 }, // outside the window
  ];
  const stats = globalFatigueStats(sessions, now);
  assert.equal(stats.sessionsLast24h, 2);
  assert.equal(stats.totalActiveMinLast24h, 15);
});

test('globalFatigueStats returns zeros with no sessions', () => {
  assert.deepEqual(globalFatigueStats([], Date.now()), { sessionsLast24h: 0, totalActiveMinLast24h: 0 });
});

test('globalFrictionCount24h counts denials and overrides across every hostname in the last 24h', () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const sessions = [
    { hostname: 'a.com', grantedAt: dayAgo + 1000, decision: 'deny' },
    { hostname: 'b.com', grantedAt: dayAgo + 2000, decision: 'grant', overridden: true },
    { hostname: 'a.com', grantedAt: dayAgo + 3000, decision: 'grant' }, // an ordinary grant isn't friction
    { hostname: 'a.com', grantedAt: dayAgo - 1000, decision: 'deny' }, // outside the window
  ];
  assert.equal(globalFrictionCount24h(sessions, now), 2);
});

test('globalFrictionCount24h returns 0 with no sessions', () => {
  assert.equal(globalFrictionCount24h([], Date.now()), 0);
});

test('getFreeTimeBandit constructs a fresh bandit sized to FREE_TIME_DURATIONS_MIN with no saved state', () => {
  const store = { freeTimeBanditState: null, settings: { freeTimeAlpha: 0.15, freeTimeDiscountFactor: 0.99 } };
  const bandit = getFreeTimeBandit(store);
  assert.equal(bandit.arms.length, FREE_TIME_DURATIONS_MIN.length);
  assert.equal(bandit.alpha, 0.15);
});

test('getFreeTimeBandit restores saved state and reapplies current settings', () => {
  const fresh = getFreeTimeBandit({ freeTimeBanditState: null, settings: { freeTimeAlpha: 0.15, freeTimeDiscountFactor: 0.99 } });
  fresh.update(0, [1, 0, 0, 0, 0, 0, 0], 0.3);
  const saved = fresh.toJSON();

  const restored = getFreeTimeBandit({ freeTimeBanditState: saved, settings: { freeTimeAlpha: 0.4, freeTimeDiscountFactor: 0.9 } });
  assert.equal(restored.alpha, 0.4, 'settings changes apply even to restored state');
  assert.deepEqual(restored.arms[0].b, fresh.arms[0].b, 'learned state carries over');
});

test('getFreeTimeBandit starts fresh if the saved arm count no longer matches FREE_TIME_DURATIONS_MIN', () => {
  const stale = { d: 7, alpha: 1, gamma: 1, arms: [{ A: [[1]], b: [0] }] }; // wrong arm count
  const bandit = getFreeTimeBandit({ freeTimeBanditState: stale, settings: { freeTimeAlpha: 0.15, freeTimeDiscountFactor: 0.99 } });
  assert.equal(bandit.arms.length, FREE_TIME_DURATIONS_MIN.length);
});
