// Pure(ish) helpers used by background.js, split out so they can be unit
// tested without mocking the chrome.* APIs the rest of the service worker
// depends on.

// ---- declarativeNetRequest rule ids -----------------------------------

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function ruleIdFor(hostname, ruleIds, nextRuleId) {
  if (ruleIds[hostname]) return { id: ruleIds[hostname], ruleIds, nextRuleId };
  const id = nextRuleId;
  ruleIds[hostname] = id;
  return { id, ruleIds, nextRuleId: nextRuleId + 1 };
}

// ---- grants -------------------------------------------------------------

export function makeGrant(armIndex, durationMin, context, now, targetUrl, extra = {}) {
  return {
    armIndex,
    durationMin,
    context,
    grantedAt: now,
    expiresAt: now + durationMin * 60 * 1000,
    activeSeconds: 0,
    targetUrl,
    ...extra,
  };
}

// ---- recent-usage stats --------------------------------------------------

export function recentStatsFor(sessions, hostname, nowMs, frequencyWindowMin = 0, overrideWindowMin = 0) {
  const dayAgo = nowMs - 24 * 60 * 60 * 1000;
  const windowAgo = nowMs - frequencyWindowMin * 60 * 1000;
  const overrideWindowAgo = nowMs - overrideWindowMin * 60 * 1000;
  const hostSessions = sessions.filter((s) => s.hostname === hostname);
  const last24h = hostSessions.filter((s) => s.grantedAt >= dayAgo);
  const inFrequencyWindow = hostSessions.filter((s) => s.decision === 'grant' && s.grantedAt >= windowAgo);
  const recentOverrides = hostSessions.filter((s) => s.overridden && s.grantedAt >= overrideWindowAgo);
  const recentFive = hostSessions.slice(-5);
  const avgRecentActiveMin = recentFive.length
    ? recentFive.reduce((sum, s) => sum + (s.activeMinutes || 0), 0) / recentFive.length
    : 0;
  return {
    sessionsLast24h: last24h.length,
    avgRecentActiveMin,
    sessionsInFrequencyWindow: inFrequencyWindow.length,
    overridesInWindow: recentOverrides.length,
  };
}
