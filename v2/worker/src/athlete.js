// ── Athlete State ─────────────────────────────────────────────────────────────
// Single source of truth, assembled in the Worker from Notion + KV + Strava data.
// The frontend receives this object and renders it; it never builds its own context.

import { notionReq, queryAll, mapPage, mapHelsePage } from './notion.js';

const STATE_TTL  = 5 * 60;   // 5 min — short enough to pick up Strava sync
const HEALTH_TTL = 5 * 60;

// ── Profile ───────────────────────────────────────────────────────────────────

/** Read mutable profile from KV (maxHR, zones, weight, injuries, etc.) */
export async function getProfile(env) {
  const raw = await env.KV.get('v2_profile');
  return raw ? JSON.parse(raw) : defaultProfile();
}

export async function saveProfile(env, patch) {
  const current = await getProfile(env);
  const next = { ...current, ...patch };
  await env.KV.put('v2_profile', JSON.stringify(next));
  await env.KV.delete('v2_state_cache');
  return next;
}

function defaultProfile() {
  return {
    maxHR: 195,
    vekt: 75,
    fodselsdato: null,
    soner: [
      { n: 'S1', min: 0,   max: 139 },
      { n: 'S2', min: 140, max: 155 },
      { n: 'S3', min: 156, max: 167 },
      { n: 'S4', min: 168, max: 179 },
      { n: 'S5', min: 180, max: 999 },
    ],
    aktiveSporter: ['Løp'],
    fokussport: 'Løp',
    skader: '',      // free text — "Hoftefleksor venstre, 3/10"
    rehabFokus: '',  // what physio prescribed
    fasiliteter: '', // "Tredemølle, vekter, friidrettsbane"
    faseNavn: 'Fase 0',
    fasePrinsipper: '',
    kontekst: '',    // general athlete context stored in Notion, mirrored here
  };
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function getSessions(env) {
  const cached = await env.KV.get('v2_okter_cache');
  if (cached) return JSON.parse(cached);

  const pages = await queryAll(env, env.DB_ID, null, [{ property: 'Dato', direction: 'descending' }]);
  const sessions = pages.map(mapPage);
  await env.KV.put('v2_okter_cache', JSON.stringify(sessions), { expirationTtl: STATE_TTL });
  return sessions;
}

export async function invalidateSessionCache(env) {
  await env.KV.delete('v2_okter_cache');
  await env.KV.delete('v2_state_cache');
}

// ── Health ────────────────────────────────────────────────────────────────────

async function getRecentHealth(env, days = 14) {
  const cached = await env.KV.get('v2_health_cache');
  if (cached) return JSON.parse(cached);

  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  const pages = await queryAll(env, env.HELSE_DB_ID,
    { property: 'Dato', date: { on_or_after: since } },
    [{ property: 'Dato', direction: 'descending' }]
  );
  const health = pages.map(mapHelsePage);
  await env.KV.put('v2_health_cache', JSON.stringify(health), { expirationTtl: HEALTH_TTL });
  return health;
}

export async function invalidateHealthCache(env) {
  await env.KV.delete('v2_health_cache');
}

// ── Load metrics ──────────────────────────────────────────────────────────────

/**
 * Acute:Chronic Workload Ratio.
 * Acute  = sum of varighet (min) last 7 days
 * Chronic = average weekly load over last 4 weeks
 */
export function computeACWR(sessions) {
  const today = new Date();
  const dayAgo = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d.toISOString().split('T')[0];
  };

  const done = sessions.filter(s => s.status === 'Gjennomført' && s.varighet && s.dato);

  const inRange = (s, fromDaysAgo, toDaysAgo) =>
    s.dato >= dayAgo(fromDaysAgo) && s.dato <= dayAgo(toDaysAgo);

  const acute = done.filter(s => inRange(s, 6, 0)).reduce((a, s) => a + s.varighet, 0);

  // Chronic: average of 4 one-week buckets (4 weeks back, non-overlapping)
  const weekLoads = [0, 1, 2, 3].map(w => {
    const from = 7 + w * 7;
    const to   = w * 7;
    return done.filter(s => inRange(s, from - 1, to)).reduce((a, s) => a + s.varighet, 0);
  });
  const chronic = weekLoads.reduce((a, b) => a + b, 0) / 4;

  const ratio = chronic > 0 ? Math.round((acute / chronic) * 100) / 100 : null;
  return { acute, chronic: Math.round(chronic), ratio };
}

/**
 * Zone distribution — % of completed sessions by type.
 * Types mapped to load zones: S1/S2 = base, Terskel/S3 = threshold, Bakkeintervall = VO2.
 */
export function computeZoneDist(sessions) {
  const done = sessions.filter(s =>
    s.status === 'Gjennomført' && s.varighet &&
    s.type !== 'Dagbok' && s.type !== 'Mål'
  );
  if (!done.length) return null;

  const totalMin = done.reduce((a, s) => a + (s.varighet || 0), 0);
  const byType = {};
  for (const s of done) {
    byType[s.type] = (byType[s.type] || 0) + (s.varighet || 0);
  }

  return Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, min]) => ({ type, pct: Math.round(min / totalMin * 100) }));
}

// ── Intensity adherence ───────────────────────────────────────────────────────

/**
 * For each completed session that had a target HR (planlagtPuls), compute whether
 * faktiskSnittHR hit the target range.
 *
 * planlagtPuls format: "140-155" or "under 145" or "155+" etc.
 * Returns { hit, low, high, total, rate, sessions[] }
 */
export function computeIntensityAdherence(sessions) {
  const results = sessions
    .filter(s => s.status === 'Gjennomført' && s.planlagtPuls && s.faktiskSnittHR)
    .slice(0, 20)
    .map(s => {
      const { low, high } = parsePulseRange(s.planlagtPuls);
      const hr = s.faktiskSnittHR;
      const margin = 5; // ±5 bpm grace
      let result;
      if (hr < low - margin)  result = 'for_lett';
      else if (hr > high + margin) result = 'for_hardt';
      else result = 'treff';
      return { dato: s.dato, navn: s.navn, type: s.type, hr, target: s.planlagtPuls, result };
    });

  const total   = results.length;
  const hit     = results.filter(r => r.result === 'treff').length;
  const tooHard = results.filter(r => r.result === 'for_hardt').length;
  const tooEasy = results.filter(r => r.result === 'for_lett').length;
  const rate    = total ? Math.round(hit / total * 100) : null;

  return { hit, tooHard, tooEasy, total, rate, sessions: results };
}

function parsePulseRange(str) {
  if (!str) return { low: 0, high: 999 };
  const m = str.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (m) return { low: Number(m[1]), high: Number(m[2]) };
  const under = str.match(/under\s+(\d+)/i);
  if (under) return { low: 0, high: Number(under[1]) };
  const plus = str.match(/(\d+)\+/);
  if (plus) return { low: Number(plus[1]), high: 999 };
  const single = str.match(/(\d+)/);
  if (single) return { low: Number(single[1]) - 5, high: Number(single[1]) + 5 };
  return { low: 0, high: 999 };
}

// ── Pain tracking ─────────────────────────────────────────────────────────────

export function computePainTrend(sessions) {
  const withPain = sessions
    .filter(s => s.status === 'Gjennomført' && s.smerte != null)
    .slice(0, 10);

  if (!withPain.length) return null;

  const avg = Math.round(withPain.reduce((a, s) => a + s.smerte, 0) / withPain.length * 10) / 10;
  const latest = withPain[0]?.smerte ?? null;
  const trend  = withPain.length >= 3
    ? withPain.slice(0, 3).reduce((a, s) => a + s.smerte, 0) / 3 -
      withPain.slice(-3).reduce((a, s) => a + s.smerte, 0) / 3
    : 0;

  return { avg, latest, trend: Math.round(trend * 10) / 10, count: withPain.length };
}

// ── Readiness ─────────────────────────────────────────────────────────────────

/**
 * Compute today's readiness from HRV, sleep, load, and pain.
 * Returns { signal: 'green'|'yellow'|'red', score: 0-100, reasons[], prescription }
 *
 * prescription = what to do with today's planned session:
 *   'as_planned' | 'reduce_intensity' | 'swap_easy' | 'rest'
 */
export function computeReadiness(profile, health, sessions, today) {
  const todayHealth = health.find(h => h.dato === today);
  const recentHealth = health.slice(0, 7); // last week

  const reasons = [];
  let score = 100;

  // ── HRV ──
  let hrvSignal = null;
  if (todayHealth?.hrv) {
    const hrv = todayHealth.hrv;
    const avgHRV = recentHealth.filter(h => h.hrv).reduce((a, h, _, arr) =>
      a + h.hrv / arr.length, 0);
    if (avgHRV > 0) {
      const drop = (avgHRV - hrv) / avgHRV;
      if (drop > 0.15) {
        score -= 30;
        reasons.push(`HRV ${hrv} ms — ${Math.round(drop * 100)}% under 7-dagers snitt (${Math.round(avgHRV)} ms)`);
        hrvSignal = 'low';
      } else if (drop > 0.08) {
        score -= 15;
        reasons.push(`HRV litt lav (${hrv} ms vs. snitt ${Math.round(avgHRV)} ms)`);
        hrvSignal = 'slightly_low';
      }
    }
  }

  // ── Sleep ──
  if (todayHealth?.sovnTimer != null) {
    const t = todayHealth.sovnTimer;
    if (t < 5.5) { score -= 25; reasons.push(`Søvn kritisk lav: ${t}t`); }
    else if (t < 7) { score -= 10; reasons.push(`Søvn noe lav: ${t}t`); }
  }
  if (todayHealth?.sovnKvalitet === 1) {
    score -= 10; reasons.push('Søvnkvalitet dårlig');
  }

  // ── Recent pain ──
  const painTrend = computePainTrend(sessions.slice(0, 5));
  if (painTrend?.latest != null) {
    if (painTrend.latest > 5) {
      score -= 30; reasons.push(`Smerte ${painTrend.latest}/10 siste økt — høyt`);
    } else if (painTrend.latest > 3) {
      score -= 15; reasons.push(`Smerte ${painTrend.latest}/10 siste økt`);
    }
  }

  // ── Load (ACWR) ──
  const acwr = computeACWR(sessions);
  if (acwr.ratio != null) {
    if (acwr.ratio > 1.5) {
      score -= 20; reasons.push(`Belastning høy — ACWR ${acwr.ratio} (risikosone)`);
    } else if (acwr.ratio > 1.3) {
      score -= 10; reasons.push(`ACWR ${acwr.ratio} — lett forhøyet`);
    } else if (acwr.ratio < 0.5 && acwr.chronic > 0) {
      reasons.push(`ACWR lav (${acwr.ratio}) — forsiktig med å lade opp for fort`);
    }
  }

  // ── Energy ──
  if (todayHealth?.energi != null && todayHealth.energi <= 2) {
    score -= 10; reasons.push(`Energinivå lavt (${todayHealth.energi}/5)`);
  }

  score = Math.max(0, Math.min(100, score));

  const signal      = score >= 75 ? 'green' : score >= 50 ? 'yellow' : 'red';
  const prescription = score >= 75 ? 'as_planned'
                     : score >= 60 ? 'reduce_intensity'
                     : score >= 40 ? 'swap_easy'
                     : 'rest';

  return {
    signal,
    score,
    reasons: reasons.length ? reasons : ['Alt ser bra ut'],
    prescription,
    data: {
      hrv:   todayHealth?.hrv   ?? null,
      sovn:  todayHealth?.sovnTimer ?? null,
      smerte: painTrend?.latest ?? null,
      acwr:  acwr.ratio,
    },
  };
}

// ── Full athlete state ────────────────────────────────────────────────────────

/**
 * Assemble the complete athlete state object.
 * This is what the frontend receives for every view — it never builds its own context.
 */
export async function assembleState(env, today) {
  const cacheKey = `v2_state_${today}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const [profile, sessions, health] = await Promise.all([
    getProfile(env),
    getSessions(env),
    getRecentHealth(env, 14),
  ]);

  const done     = sessions.filter(s => s.status === 'Gjennomført' && s.dato);
  const upcoming = sessions
    .filter(s => s.status === 'To Do' && s.dato >= today)
    .sort((a, b) => a.dato.localeCompare(b.dato));
  const goals = sessions
    .filter(s => (s.type === 'Race' || s.type === 'Mål') && s.dato >= today)
    .sort((a, b) => a.dato.localeCompare(b.dato));

  const readiness   = computeReadiness(profile, health, done, today);
  const acwr        = computeACWR(done);
  const zoneDist    = computeZoneDist(done);
  const adherence   = computeIntensityAdherence(done);
  const painTrend   = computePainTrend(done);

  const state = {
    today,
    profile,
    readiness,
    metrics: { acwr, zoneDist, adherence, painTrend },
    sessions: {
      recent:   done.slice(0, 30),
      upcoming: upcoming.slice(0, 14),
      today:    sessions.filter(s => s.dato === today),
    },
    goals: goals.slice(0, 5),
    health: health.slice(0, 7),
  };

  await env.KV.put(cacheKey, JSON.stringify(state), { expirationTtl: STATE_TTL });
  return state;
}
