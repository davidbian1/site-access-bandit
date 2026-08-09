from eval.simulate import SiteHistory


def test_recent_count_only_counts_grants_not_denials():
    """Regression test for a fidelity bug: recent_count() used to count every
    recorded round (including denials) toward the frequency signal fed into
    the reward function, but the real recentStatsFor() in
    lib/background-helpers.js only counts sessions where decision === 'grant'.
    Denials must not inflate the simulated frequency penalty."""
    history = SiteHistory()
    history.record(t=0.0, active_minutes=0.0, was_grant=False)
    history.record(t=1.0, active_minutes=0.0, was_grant=False)
    history.record(t=2.0, active_minutes=5.0, was_grant=True)

    assert history.recent_count(t=2.0, window_min=30) == 1


def test_recent_count_respects_the_window():
    history = SiteHistory()
    history.record(t=0.0, active_minutes=5.0, was_grant=True)
    history.record(t=100.0, active_minutes=5.0, was_grant=True)

    assert history.recent_count(t=100.0, window_min=30) == 1
    assert history.recent_count(t=100.0, window_min=200) == 2


def test_avg_recent_active_includes_denials_as_zero():
    """Unlike recent_count, this one is deliberately unfiltered - matches
    avgRecentActiveMin in the real implementation, which averages over the
    last 5 sessions regardless of decision (a denial contributes 0)."""
    history = SiteHistory()
    history.record(t=0.0, active_minutes=10.0, was_grant=True)
    history.record(t=1.0, active_minutes=0.0, was_grant=False)

    assert history.avg_recent_active(t=1.0) == 5.0


def test_sessions_last_24h_includes_denials():
    """Also deliberately unfiltered - matches sessionsLast24h in the real
    implementation."""
    history = SiteHistory()
    history.record(t=0.0, active_minutes=0.0, was_grant=False)
    history.record(t=10.0, active_minutes=5.0, was_grant=True)

    assert history.sessions_last_24h(t=10.0) == 2
