import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSettings,
  computeGrantReward,
  computeCooldownSec,
  computeOverrideDelaySec,
  recentDenyStreak,
  decayedTrust,
  applyTrustDiscount,
  buildContext,
  normalizeHostname,
  hostnameFromUrl,
} from './config.js';

test('computeGrantReward never returns a positive value', () => {
  const s = defaultSettings();
  assert.ok(computeGrantReward(0, 0, false, s) <= 0);
  assert.ok(computeGrantReward(1, 0, false, s) <= 0);
  assert.ok(computeGrantReward(0, 0, true, s) <= 0);
});

test('computeGrantReward scales with active minutes and clamps at -1', () => {
  const s = defaultSettings();
  const short = computeGrantReward(2, 0, false, s);
  const long = computeGrantReward(20, 0, false, s);
  assert.ok(long < short, 'longer sessions should be penalized more');
  assert.equal(computeGrantReward(1000, 0, false, s), -1, 'clamps at the floor');
});

test('computeGrantReward applies an extra penalty for overridden sessions', () => {
  const s = defaultSettings();
  const normal = computeGrantReward(2, 0, false, s);
  const overridden = computeGrantReward(2, 0, true, s);
  assert.ok(overridden < normal);
  assert.ok(Math.abs(normal - overridden - s.overrideSessionPenalty) < 1e-9);
});

test('computeGrantReward frequency penalty caps at maxFrequencyPenalty', () => {
  const s = defaultSettings();
  const cappedReward = computeGrantReward(0, 1000, false, s);
  assert.equal(cappedReward, -s.maxFrequencyPenalty);
});

test('computeCooldownSec clamps between the floor and ceiling', () => {
  const s = defaultSettings();
  assert.equal(computeCooldownSec(0, s), s.minCooldownSec);
  assert.equal(computeCooldownSec(10000, s), s.maxCooldownSec);
  const mid = computeCooldownSec(1, s);
  assert.ok(mid > s.minCooldownSec && mid < s.maxCooldownSec);
});

test('computeOverrideDelaySec ramps up with recent overrides and down with deny streak', () => {
  const s = defaultSettings();
  const base = computeOverrideDelaySec(0, 0, s);
  assert.equal(base, s.overrideBaseDelaySec);

  const afterOverrides = computeOverrideDelaySec(3, 0, s);
  assert.ok(afterOverrides > base, 'repeated overrides should raise the wait');

  const afterEffort = computeOverrideDelaySec(0, 5, s);
  assert.ok(afterEffort < base, 'a genuine deny streak should lower the wait');

  assert.ok(computeOverrideDelaySec(0, 1000, s) >= 0, 'never goes negative');
  assert.ok(computeOverrideDelaySec(1000, 0, s) <= s.overrideMaxDelaySec, 'clamps at the ceiling');
});

test('recentDenyStreak counts only consecutive trailing denials', () => {
  const sessions = [
    { hostname: 'x.com', decision: 'grant', overridden: false },
    { hostname: 'x.com', decision: 'deny', overridden: false },
    { hostname: 'x.com', decision: 'deny', overridden: false },
    { hostname: 'x.com', decision: 'deny', overridden: false },
  ];
  assert.equal(recentDenyStreak(sessions, 'x.com'), 3);
});

test('recentDenyStreak stops at an overridden denial or a grant', () => {
  const stoppedByOverride = [
    { hostname: 'x.com', decision: 'deny', overridden: true },
    { hostname: 'x.com', decision: 'deny', overridden: false },
  ];
  assert.equal(recentDenyStreak(stoppedByOverride, 'x.com'), 1);

  const stoppedByGrant = [
    { hostname: 'x.com', decision: 'grant' },
    { hostname: 'x.com', decision: 'deny', overridden: false },
  ];
  assert.equal(recentDenyStreak(stoppedByGrant, 'x.com'), 1);
});

test('recentDenyStreak ignores other hostnames and returns 0 with no history', () => {
  assert.equal(recentDenyStreak([], 'x.com'), 0);
  const other = [{ hostname: 'y.com', decision: 'deny', overridden: false }];
  assert.equal(recentDenyStreak(other, 'x.com'), 0);
});

test('decayedTrust returns 0 for no entry and decays by half at one half-life', () => {
  const now = Date.now();
  assert.equal(decayedTrust(undefined, now, 90), 0);

  const oneHalfLifeAgo = { value: 0.6, updatedAt: now - 90 * 60000 };
  const decayed = decayedTrust(oneHalfLifeAgo, now, 90);
  assert.ok(Math.abs(decayed - 0.3) < 1e-9);

  const twoHalfLivesAgo = { value: 0.6, updatedAt: now - 180 * 60000 };
  const decayedTwice = decayedTrust(twoHalfLivesAgo, now, 90);
  assert.ok(Math.abs(decayedTwice - 0.15) < 1e-9);
});

test('decayedTrust clamps to [0, 1]', () => {
  const now = Date.now();
  const overOne = decayedTrust({ value: 5, updatedAt: now }, now, 90);
  assert.ok(overOne <= 1);
});

test('applyTrustDiscount reduces the value proportionally to trust and the configured cap', () => {
  const s = defaultSettings();
  assert.equal(applyTrustDiscount(100, 0, s), 100, 'no trust, no discount');
  const discounted = applyTrustDiscount(100, 1, s);
  assert.ok(Math.abs(discounted - (100 * (1 - s.trustMaxDiscount))) < 1e-9);
});

test('buildContext returns a 7-dimensional vector with a bias term and bounded values', () => {
  const context = buildContext(new Date('2026-01-15T14:30:00'), { sessionsLast24h: 3, avgRecentActiveMin: 12 });
  assert.equal(context.length, 7);
  assert.equal(context[0], 1, 'bias term');
  for (const v of context.slice(1, 5)) {
    assert.ok(v >= -1 && v <= 1, 'sin/cos terms stay in [-1, 1]');
  }
  for (const v of context.slice(5)) {
    assert.ok(v >= 0 && v <= 1, 'normalized recent-usage terms stay in [0, 1]');
  }
});

test('normalizeHostname strips scheme, path, and leading www', () => {
  assert.equal(normalizeHostname('https://www.example.com/path?q=1'), 'example.com');
  assert.equal(normalizeHostname('example.com'), 'example.com');
  assert.equal(normalizeHostname('not a url'), null);
});

test('hostnameFromUrl strips leading www and returns null for invalid input', () => {
  assert.equal(hostnameFromUrl('https://www.example.com/watch?v=1'), 'example.com');
  assert.equal(hostnameFromUrl('not a url'), null);
});
