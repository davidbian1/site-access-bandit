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
