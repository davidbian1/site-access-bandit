import numpy as np

from eval.simulate_warmstart import warm_start_arms


def test_zero_shrinkage_is_identical_to_cold_start():
    siblings = [[{"A": np.eye(2) * 5, "b": np.array([1.0, 2.0])}]]
    arms = warm_start_arms(siblings, n_arms=1, d=2, shrinkage=0.0)
    assert np.allclose(arms[0]["A"], np.eye(2))
    assert np.allclose(arms[0]["b"], np.zeros(2))


def test_no_siblings_falls_back_to_cold_start_even_with_shrinkage():
    arms = warm_start_arms([], n_arms=1, d=2, shrinkage=0.5)
    assert np.allclose(arms[0]["A"], np.eye(2))
    assert np.allclose(arms[0]["b"], np.zeros(2))


def test_warm_start_borrows_only_a_fraction_of_a_single_siblings_learned_state():
    # One sibling with a clearly non-trivial learned A/b.
    sibling_A = np.eye(2) + np.array([[2.0, 0.0], [0.0, 2.0]])  # "learned" contribution is +2*I
    sibling_b = np.array([4.0, 0.0])
    siblings = [[{"A": sibling_A, "b": sibling_b}]]

    arms = warm_start_arms(siblings, n_arms=1, d=2, shrinkage=0.25)
    # A = I + shrinkage * (sibling_A - I) = I + 0.25 * 2*I = 1.5*I
    assert np.allclose(arms[0]["A"], np.eye(2) * 1.5)
    # b = shrinkage * sibling_b
    assert np.allclose(arms[0]["b"], np.array([1.0, 0.0]))


def test_warm_start_averages_across_multiple_siblings():
    siblings = [
        [{"A": np.eye(2) + np.eye(2), "b": np.array([2.0, 0.0])}],  # learned contribution +1*I, b=[2,0]
        [{"A": np.eye(2) + np.eye(2) * 3, "b": np.array([0.0, 6.0])}],  # learned contribution +3*I, b=[0,6]
    ]
    arms = warm_start_arms(siblings, n_arms=1, d=2, shrinkage=1.0)
    # average learned A contribution = 2*I, average b = [1, 3]
    assert np.allclose(arms[0]["A"], np.eye(2) + np.eye(2) * 2)
    assert np.allclose(arms[0]["b"], np.array([1.0, 3.0]))


def test_warm_started_A_stays_invertible():
    siblings = [[{"A": np.eye(3) * 0.01, "b": np.zeros(3)}]]  # a pathologically small A
    arms = warm_start_arms(siblings, n_arms=1, d=3, shrinkage=0.9)
    # Should not raise, and should still be a valid (invertible) matrix.
    inv = np.linalg.inv(arms[0]["A"])
    assert np.all(np.isfinite(inv))
