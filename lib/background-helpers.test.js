import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeRegex, ruleIdFor, makeGrant, recentStatsFor } from './background-helpers.js';

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
