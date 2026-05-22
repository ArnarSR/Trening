const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const DB_ID = '953ee9299ea345fb8a3d77cf8237116a';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SPORT_MAP = {
  run:              { type: '🏃 Løp',           icon: '🏃' },
  trailrun:         { type: '🏃 Løp',           icon: '🏃' },
  ride:             { type: '🚴 Sykkel',         icon: '🚴' },
  virtualride:      { type: '🚴 Sykkel',         icon: '🚴' },
  mountainbikeride: { type: '🚵 Terrengsykkel',  icon: '🚵' },
  swim:             { type: '🏊 Svømming',        icon: '🏊' },
  hiking:           { type: '🥾 Fjelltur',        icon: '🥾' },
  walk:             { type: '🚶 Gåtur',           icon: '🚶' },
  backcountryski:   { type: '🎿 Randonee',        icon: '🎿' },
  nordicski:        { type: '⛷️ Langrenn',        icon: '⛷️' },
  workout:          { type: '💪 Styrke',          icon: '💪' },
  weighttraining:   { type: '💪 Styrke',          icon: '💪' },
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /api/okter
      if (path === '/api/okter' && request.method === 'GET') {
        const res = await notionRequest(env, 'POST', `/databases/${DB_ID}/query`, {
          sorts: [{ property: 'Dato', direction: 'descending' }],
          page_size: 100,
        });
        const data = await res.json();
        if (!res.ok || !data.results) {
          return json({ error: 'Notion feil', detail: data }, res.status || 500);
        }
        return json({ okter: data.results.map(mapPage) });
      }

      // PATCH /api/okter/:id
      if (path.startsWith('/api/okter/') && request.method === 'PATCH') {
        const pageId = path.replace('/api/okter/', '');
        const body = await request.json();
        const props = buildNotionProps(body);
        const patchBody = { properties: props };
        if (body.icon) patchBody.icon = { type: 'emoji', emoji: body.icon };
        const res = await notionRequest(env, 'PATCH', `/pages/${pageId}`, patchBody);
        const data = await res.json();
        return json({ ok: true, id: data.id });
      }

      // POST /api/okter
      if (path === '/api/okter' && request.method === 'POST') {
        const body = await request.json();
        const props = buildNotionProps(body);
        if (body.navn) {
          props['Navn'] = { title: [{ text: { content: body.navn } }] };
        }
        const createBody = { parent: { database_id: DB_ID }, properties: props };
        if (body.icon) createBody.icon = { type: 'emoji', emoji: body.icon };
        const res = await notionRequest(env, 'POST', '/pages', createBody);
        const data = await res.json();
        return json({ ok: true, id: data.id });
      }

      // POST /api/sync
      if (path === '/api/sync' && request.method === 'POST') {
        return syncStrava(env);
      }

      // POST /api/analyse
      if (path === '/api/analyse' && request.method === 'POST') {
        const { prompt } = await request.json();
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 1000,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const data = await res.json();
        const text = data.content?.find(b => b.type === 'text')?.text || '';
        return json({ text });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

// ── Strava sync ───────────────────────────────────────────────────────────────

async function syncStrava(env) {
  // Refresh access token
  const tokenRes = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      refresh_token: env.STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    return json({ error: 'Strava token feil', detail: tokenData }, 500);
  }

  // Fetch last 80 activities
  const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=80', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const activities = await actRes.json();
  if (!Array.isArray(activities)) {
    return json({ error: 'Strava aktiviteter feil', detail: activities }, 500);
  }

  // Find oldest date among activities
  const dates = activities
    .map(a => a.start_date_local?.split('T')[0])
    .filter(Boolean)
    .sort();
  if (!dates.length) return json({ synced: 0, created: 0, total: 0 });
  const oldest = dates[0];

  // Query Notion for all pages since oldest activity date
  const notionPages = await queryNotionSince(env, oldest);
  // Date → first matching page
  const dateMap = {};
  for (const page of notionPages) {
    const dato = page.properties['Dato']?.date?.start;
    if (dato && !dateMap[dato]) dateMap[dato] = page;
  }

  let synced = 0, created = 0;

  for (const activity of activities) {
    const date = activity.start_date_local?.split('T')[0];
    if (!date) continue;

    const sportKey = (activity.sport_type || activity.type || '').toLowerCase();
    const sport = SPORT_MAP[sportKey];
    const avgHR = activity.average_heartrate ? Math.round(activity.average_heartrate) : null;
    const maxHR = activity.max_heartrate ? Math.round(activity.max_heartrate) : null;
    const duration = activity.elapsed_time ? Math.round(activity.elapsed_time / 60) : null;
    const pace = activity.average_speed > 0 ? formatPace(activity.average_speed) : null;
    const name = activity.name || 'Strava-økt';

    if (dateMap[date]) {
      const pageId = dateMap[date].id;
      const props = {};
      if (avgHR !== null) props['Faktisk snitt HR'] = { number: avgHR };
      if (maxHR !== null) props['Faktisk maks HR'] = { number: maxHR };
      if (duration !== null) props['Varighet (min)'] = { number: duration };
      if (pace) props['Pace'] = { rich_text: [{ text: { content: pace } }] };
      if (sport) props['Type'] = { select: { name: sport.type } };

      const patchBody = { properties: props };
      if (sport) patchBody.icon = { type: 'emoji', emoji: sport.icon };
      await notionRequest(env, 'PATCH', `/pages/${pageId}`, patchBody);
      synced++;
    } else {
      const props = {
        'Navn': { title: [{ text: { content: name } }] },
        'Dato': { date: { start: date } },
      };
      if (avgHR !== null) props['Faktisk snitt HR'] = { number: avgHR };
      if (maxHR !== null) props['Faktisk maks HR'] = { number: maxHR };
      if (duration !== null) props['Varighet (min)'] = { number: duration };
      if (pace) props['Pace'] = { rich_text: [{ text: { content: pace } }] };
      if (sport) props['Type'] = { select: { name: sport.type } };

      const createBody = { parent: { database_id: DB_ID }, properties: props };
      if (sport) createBody.icon = { type: 'emoji', emoji: sport.icon };
      await notionRequest(env, 'POST', '/pages', createBody);
      dateMap[date] = { id: 'new' };
      created++;
    }
  }

  return json({ synced, created, total: activities.length });
}

async function queryNotionSince(env, since) {
  const pages = [];
  let cursor;
  do {
    const body = {
      filter: { property: 'Dato', date: { on_or_after: since } },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const res = await notionRequest(env, 'POST', `/databases/${DB_ID}/query`, body);
    const data = await res.json();
    if (data.results) pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return pages;
}

function formatPace(speedMs) {
  const minPerKm = 1000 / (speedMs * 60);
  const mins = Math.floor(minPerKm);
  const secs = Math.round((minPerKm - mins) * 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function notionRequest(env, method, path, body) {
  return fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function mapPage(page) {
  const p = page.properties;
  return {
    id: page.id,
    navn: p['Navn']?.title?.[0]?.plain_text || '',
    type: p['Type']?.select?.name || '',
    status: p['Status']?.select?.name || '',
    fase: p['Fase']?.select?.name || '',
    dato: p['Dato']?.date?.start || '',
    planlagtPuls: p['Planlagt puls']?.rich_text?.[0]?.plain_text || '',
    faktiskSnittHR: p['Faktisk snitt HR']?.number || null,
    faktiskMaksHR: p['Faktisk maks HR']?.number || null,
    varighet: p['Varighet (min)']?.number || null,
    pace: p['Pace']?.rich_text?.[0]?.plain_text || '',
    smerte: p['Smerte 0-10']?.number ?? null,
    medVogn: p['Med vogn']?.checkbox || false,
    vurdering: p['Vurdering']?.rich_text?.[0]?.plain_text || '',
    url: page.url,
  };
}

function buildNotionProps(body) {
  const props = {};
  if (body.status)   props['Status']   = { select: { name: body.status } };
  if (body.type)     props['Type']     = { select: { name: body.type } };
  if (body.fase)     props['Fase']     = { select: { name: body.fase } };
  if (body.dato)     props['Dato']     = { date: { start: body.dato } };
  if (body.vurdering !== undefined)
    props['Vurdering'] = { rich_text: [{ text: { content: body.vurdering } }] };
  if (body.pace !== undefined)
    props['Pace'] = { rich_text: [{ text: { content: body.pace } }] };
  if (body.planlagtPuls !== undefined)
    props['Planlagt puls'] = { rich_text: [{ text: { content: body.planlagtPuls } }] };
  if (body.faktiskSnittHR != null)
    props['Faktisk snitt HR'] = { number: body.faktiskSnittHR };
  if (body.faktiskMaksHR != null)
    props['Faktisk maks HR'] = { number: body.faktiskMaksHR };
  if (body.varighet != null)
    props['Varighet (min)'] = { number: body.varighet };
  if (body.smerte != null)
    props['Smerte 0-10'] = { number: body.smerte };
  if (body.medVogn !== undefined)
    props['Med vogn'] = { checkbox: body.medVogn };
  return props;
}
