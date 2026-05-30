// ── Strava sync ───────────────────────────────────────────────────────────────
// Adapted from v1. Uses v2 KV binding (env.KV) and invalidates v2 caches.

import { notionReq, queryAll, sessionProps } from './notion.js';
import { json } from './http.js';

const MAX_WRITES = 40;

function formatPace(metersPerSec) {
  if (!metersPerSec || metersPerSec <= 0) return null;
  const secPerKm = 1000 / metersPerSec;
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${String(sec).padStart(2, '0')}`;
}

async function getStravaToken(env) {
  const form = new FormData();
  form.append('client_id',     env.STRAVA_CLIENT_ID.trim());
  form.append('client_secret', env.STRAVA_CLIENT_SECRET.trim());
  form.append('refresh_token', env.STRAVA_REFRESH_TOKEN.trim());
  form.append('grant_type',    'refresh_token');
  const res  = await fetch('https://www.strava.com/oauth/token', { method: 'POST', body: form });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Strava token feil: ${JSON.stringify(data)}`);
  return data.access_token;
}

function syncUnchanged(existing, { avgHR, maxHR, duration, distance, pace, sportName, calories, stravaId }) {
  const p = existing.properties || {};
  if (p['Status']?.select?.name !== 'Gjennomført') return false;
  if ((p['Strava ID']?.rich_text?.[0]?.plain_text || null) !== stravaId) return false;
  if (avgHR    !== null && (p['Faktisk snitt HR']?.number ?? null) !== avgHR)    return false;
  if (maxHR    !== null && (p['Faktisk maks HR']?.number  ?? null) !== maxHR)    return false;
  if (duration !== null && (p['Varighet (min)']?.number   ?? null) !== duration) return false;
  if (distance !== null && (p['Distanse (km)']?.number    ?? null) !== distance) return false;
  if (pace     && (p['Pace']?.rich_text?.[0]?.plain_text || null) !== pace)      return false;
  if (sportName && (p['Sport']?.select?.name || null) !== sportName)             return false;
  if (calories !== null && (p['Kalorier']?.number ?? null) !== calories)         return false;
  return true;
}

async function invalidateCaches(env, today) {
  await Promise.all([
    env.KV.delete('v2_okter_cache'),
    env.KV.delete(`v2_state_${today}`),
    env.KV.delete(`v2_readiness_${today}`),
  ]);
}

export async function syncStrava(env, SPORT_MAP, today) {
  const token = await getStravaToken(env);

  const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=80', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const activities = await actRes.json();
  if (!Array.isArray(activities)) return json({ error: 'Strava aktiviteter feil', detail: activities }, 500);

  const dates = activities.map(a => a.start_date_local?.split('T')[0]).filter(Boolean).sort();
  if (!dates.length) return json({ synced: 0, created: 0, total: 0 });
  const oldest = dates[0];

  const notionPages = await queryAll(env, env.DB_ID,
    { property: 'Dato', date: { on_or_after: oldest } },
    [{ property: 'Dato', direction: 'descending' }]
  );

  const stravaMap = {};
  const dateSportMap = {};
  for (const page of notionPages) {
    const sid  = page.properties['Strava ID']?.rich_text?.[0]?.plain_text;
    const dato = page.properties['Dato']?.date?.start;
    const sport = page.properties['Sport']?.select?.name;
    if (sid && !stravaMap[sid]) stravaMap[sid] = page;
    if (dato && sport && !dateSportMap[`${dato}_${sport}`]) dateSportMap[`${dato}_${sport}`] = page;
  }

  let synced = 0, created = 0, errors = 0, skipped = 0;

  for (const activity of activities) {
    if (synced + created + errors >= MAX_WRITES) break;
    const date = activity.start_date_local?.split('T')[0];
    if (!date) continue;

    const stravaId   = String(activity.id);
    const sportKey   = (activity.sport_type || activity.type || '').toLowerCase();
    const sportName  = SPORT_MAP[sportKey] || null;
    const avgHR      = activity.average_heartrate ? Math.round(activity.average_heartrate) : null;
    const maxHR      = activity.max_heartrate ? Math.round(activity.max_heartrate) : null;
    const duration   = activity.elapsed_time ? Math.round(activity.elapsed_time / 60) : null;
    const distance   = activity.distance ? Math.round(activity.distance / 100) / 10 : null;
    const pace       = activity.average_speed > 0 ? formatPace(activity.average_speed) : null;
    const calories   = activity.calories ? Math.round(activity.calories) : null;
    const name       = activity.name || 'Strava-økt';

    const existing   = stravaMap[stravaId] || (sportName && dateSportMap[`${date}_${sportName}`]);

    if (existing && syncUnchanged(existing, { avgHR, maxHR, duration, distance, pace, sportName, calories, stravaId })) {
      stravaMap[stravaId] = existing;
      if (sportName) delete dateSportMap[`${date}_${sportName}`];
      skipped++;
      continue;
    }

    if (existing) {
      const props = { 'Status': { select: { name: 'Gjennomført' } } };
      if (avgHR    !== null) props['Faktisk snitt HR'] = { number: avgHR };
      if (maxHR    !== null) props['Faktisk maks HR']  = { number: maxHR };
      if (duration !== null) props['Varighet (min)']   = { number: duration };
      if (distance !== null) props['Distanse (km)']    = { number: distance };
      if (pace)              props['Pace']              = { rich_text: [{ text: { content: pace } }] };
      if (sportName)         props['Sport']             = { select: { name: sportName } };
      if (calories !== null) props['Kalorier']          = { number: calories };
      props['Strava ID'] = { rich_text: [{ text: { content: stravaId } }] };

      const res = await notionReq(env, 'PATCH', `/pages/${existing.id}`, { properties: props });
      if (res.ok) { stravaMap[stravaId] = existing; synced++; }
      else errors++;
      if (sportName) delete dateSportMap[`${date}_${sportName}`];
    } else {
      const props = {
        'Navn':      { title: [{ text: { content: name } }] },
        'Dato':      { date: { start: date } },
        'Status':    { select: { name: 'Gjennomført' } },
        'Strava ID': { rich_text: [{ text: { content: stravaId } }] },
      };
      if (avgHR    !== null) props['Faktisk snitt HR'] = { number: avgHR };
      if (maxHR    !== null) props['Faktisk maks HR']  = { number: maxHR };
      if (duration !== null) props['Varighet (min)']   = { number: duration };
      if (distance !== null) props['Distanse (km)']    = { number: distance };
      if (pace)              props['Pace']              = { rich_text: [{ text: { content: pace } }] };
      if (sportName)         props['Sport']             = { select: { name: sportName } };
      if (calories !== null) props['Kalorier']          = { number: calories };

      const res = await notionReq(env, 'POST', '/pages', { parent: { database_id: env.DB_ID }, properties: props });
      if (res.ok) created++;
      else errors++;
    }
  }

  if (synced + created > 0) await invalidateCaches(env, today);
  return json({ synced, created, errors, skipped, total: activities.length, capped: synced + created + errors >= MAX_WRITES });
}

export async function syncLatestStrava(env, SPORT_MAP, today) {
  const token = await getStravaToken(env);
  const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=1', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const activities = await actRes.json();
  if (!Array.isArray(activities) || !activities.length) return json({ synced: 0 });

  // Delegate to full sync (small, single activity — cost is the same)
  return syncStrava(env, SPORT_MAP, today);
}
