from eval.simulate_recency import (
    SiteHistoryRecency,
    build_context_recency,
    recency_feature,
    risk_for_recency,
)


def test_recency_feature_no_history_reads_as_maximally_stale():
    assert recency_feature(None) == 1.0


def test_recency_feature_just_visited_reads_as_zero():
    assert recency_feature(0.0) == 0.0


def test_recency_feature_caps_at_one():
    assert recency_feature(48.0) == 1.0
    assert recency_feature(1000.0) == 1.0


def test_recency_feature_scales_linearly_under_the_cap():
    assert abs(recency_feature(24.0) - 0.5) < 1e-9


def test_build_context_recency_has_eight_dimensions_with_bias_term():
    ctx = build_context_recency(hour=12, minute=0, day_of_week=3, freq_24h=0, avg_recent_active_min=0, hours_since_last=10)
    assert len(ctx) == 8
    assert ctx[0] == 1.0
    assert ctx[7] == recency_feature(10)


def test_risk_for_recency_a_quick_return_is_riskier_than_a_long_gap():
    """The whole premise this experiment tests: recency has to carry real,
    independent signal, or comparing a recency-aware bandit against a blind
    one would be a foregone conclusion either way."""
    quick_return = risk_for_recency(hour=12, recent_session_count=0, avg_recent_active_min=0, hours_since_last=0.5)
    long_gap = risk_for_recency(hour=12, recent_session_count=0, avg_recent_active_min=0, hours_since_last=48)
    assert quick_return > long_gap


def test_risk_for_recency_first_ever_visit_is_not_penalized():
    first_visit = risk_for_recency(hour=12, recent_session_count=0, avg_recent_active_min=0, hours_since_last=None)
    long_gap = risk_for_recency(hour=12, recent_session_count=0, avg_recent_active_min=0, hours_since_last=48)
    assert first_visit == long_gap


def test_site_history_recency_hours_since_last_with_no_sessions():
    history = SiteHistoryRecency()
    assert history.hours_since_last(t=100.0) is None


def test_site_history_recency_hours_since_last_computes_from_the_most_recent_session():
    history = SiteHistoryRecency()
    history.record(t=0.0, active_minutes=5.0, was_grant=True)
    history.record(t=60.0, active_minutes=0.0, was_grant=False)
    assert abs(history.hours_since_last(t=180.0) - 2.0) < 1e-9
