import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinUCB, FEATURE_DIM } from './linucb.js';

function unitContext() {
  // A simple valid context: bias term + zeros for the rest.
  return [1, 0, 0, 0, 0, 0, 0];
}

test('constructs the requested number of arms with the default feature dimension', () => {
  const bandit = new LinUCB(4, FEATURE_DIM, 1.0);
  assert.equal(bandit.arms.length, 4);
  assert.equal(bandit.d, FEATURE_DIM);
});

test('selectArm returns a valid arm index and one score per arm', () => {
  const bandit = new LinUCB(4, FEATURE_DIM, 1.0);
  const { armIndex, scores } = bandit.selectArm(unitContext());
  assert.ok(armIndex >= 0 && armIndex < 4);
  assert.equal(scores.length, 4);
  for (const s of scores) {
    assert.ok(Number.isFinite(s.mean));
    assert.ok(Number.isFinite(s.ucb));
    assert.ok(s.variance >= 0);
  }
});

test('repeatedly rewarding one arm raises its mean estimate above an untouched arm', () => {
  const bandit = new LinUCB(2, FEATURE_DIM, 0); // alpha=0 removes exploration noise from the score
  const x = unitContext();
  for (let i = 0; i < 20; i++) bandit.update(0, x, 1);
  for (let i = 0; i < 20; i++) bandit.update(1, x, -1);

  const scoreGood = bandit.arms[0].score(x, 0);
  const scoreBad = bandit.arms[1].score(x, 0);
  assert.ok(scoreGood.mean > scoreBad.mean);

  const { armIndex } = bandit.selectArm(x);
  assert.equal(armIndex, 0, 'the consistently-rewarded arm should be selected with no exploration noise');
});

test('update only affects the targeted arm', () => {
  const bandit = new LinUCB(3, FEATURE_DIM, 1.0);
  const before = bandit.arms.map((a) => JSON.stringify(a.toJSON()));
  bandit.update(1, unitContext(), 1);
  const after = bandit.arms.map((a) => JSON.stringify(a.toJSON()));

  assert.equal(after[0], before[0]);
  assert.notEqual(after[1], before[1]);
  assert.equal(after[2], before[2]);
});

test('gamma defaults to 1 (no discounting) and matches pre-discount behavior exactly', () => {
  const bandit = new LinUCB(2, FEATURE_DIM, 0.5);
  assert.equal(bandit.gamma, 1);
  const x = unitContext();
  bandit.update(0, x, 0.7);
  // With gamma=1, the regularization term added each update is (1-1)*I = 0,
  // so this should be bit-for-bit the same as the pre-discount update rule.
  const { mean } = bandit.arms[0].score(x, 0);
  assert.ok(Math.abs(mean - 0.35) < 1e-9); // theta = A^-1 b on a single unit-context update
});

test('discounting lets a policy reversal actually take hold instead of being permanently outweighed by old data', () => {
  const x = unitContext();

  const discounted = new LinUCB(1, FEATURE_DIM, 0, 0.9);
  const undiscounted = new LinUCB(1, FEATURE_DIM, 0, 1.0);

  // Both bandits see the same history: 50 strongly positive rewards (the
  // "before" behavior), then a sustained reversal to strongly negative
  // rewards (behavior that changed *because of* the earlier decisions -
  // the scenario this exists for) for another 50 rounds.
  for (let i = 0; i < 50; i++) {
    discounted.update(0, x, 1);
    undiscounted.update(0, x, 1);
  }
  for (let i = 0; i < 50; i++) {
    discounted.update(0, x, -1);
    undiscounted.update(0, x, -1);
  }

  const discountedMean = discounted.arms[0].score(x, 0).mean;
  const undiscountedMean = undiscounted.arms[0].score(x, 0).mean;

  assert.ok(
    discountedMean < undiscountedMean,
    'the discounted model should track the recent reversal more closely than one that weighs all history equally'
  );
  assert.ok(discountedMean < 0, 'discounted estimate should have actually flipped negative to reflect recent behavior');
});

test('the regularization floor keeps A well-conditioned under heavy, sustained discounting', () => {
  const bandit = new LinUCB(1, FEATURE_DIM, 1.0, 0.8);
  const x = unitContext();
  for (let i = 0; i < 500; i++) bandit.update(0, x, 1);
  const { mean, ucb, variance } = bandit.arms[0].score(x, 1.0);
  assert.ok(Number.isFinite(mean));
  assert.ok(Number.isFinite(ucb));
  assert.ok(Number.isFinite(variance) && variance >= 0);
});

test('toJSON/fromJSON round-trips gamma', () => {
  const bandit = new LinUCB(2, FEATURE_DIM, 1.0, 0.95);
  const restored = LinUCB.fromJSON(bandit.toJSON());
  assert.equal(restored.gamma, 0.95);
});

test('toJSON/fromJSON round-trips without changing scores', () => {
  const bandit = new LinUCB(3, FEATURE_DIM, 1.0);
  const x = unitContext();
  bandit.update(0, x, 0.5);
  bandit.update(1, [1, 0.2, -0.3, 0.1, 0, 0.4, 0.1], -0.8);

  const restored = LinUCB.fromJSON(bandit.toJSON());
  for (let i = 0; i < bandit.arms.length; i++) {
    const original = bandit.arms[i].score(x, 1.0);
    const roundTripped = restored.arms[i].score(x, 1.0);
    assert.ok(Math.abs(original.mean - roundTripped.mean) < 1e-9);
    assert.ok(Math.abs(original.ucb - roundTripped.ucb) < 1e-9);
  }
});
