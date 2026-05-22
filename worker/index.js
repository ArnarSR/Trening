const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const DB_ID = '953ee9299ea345fb8a3d77cf8237116a';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CAL_API   = 'https://www.googleapis.com/calendar/v3';

// GCal event color per type
const TYPE_COLOR = {
  'Sone 2': '2', 'Terskel': '5', 'Bakkeintervall': '11',
  'Race': '3', 'Styrke': '7', 'Rehab': '9',
};

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

      // GET /api/prinsipper
      if (path === '/api/prinsipper' && request.method === 'GET') {
        return getPrinsipper(env);
      }

      // POST /api/prinsipper
      if (path === '/api/prinsipper' && request.method === 'POST') {
        const { tekst } = await request.json();
        return savePrinsipper(env, tekst || '');
      }

      // GET /api/calendar
      if (path === '/api/calendar' && request.method === 'GET') {
        const from = url.searchParams.get('from') || new Date().toISOString().split('T')[0];
        const to   = url.searchParams.get('to')   || from;
        return getCalendarEvents(env, from, to);
      }

      // POST /api/plan/create
      if (path === '/api/plan/create' && request.method === 'POST') {
        const { sessions } = await request.json();
        return createPlanSessions(env, sessions || []);
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
            max_tokens: 4000,
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
  const form = new FormData();
  form.append('client_id', env.STRAVA_CLIENT_ID.trim());
  form.append('client_secret', env.STRAVA_CLIENT_SECRET.trim());
  form.append('refresh_token', env.STRAVA_REFRESH_TOKEN.trim());
  form.append('grant_type', 'refresh_token');
  const tokenRes = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    body: form,
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
  const MAX_WRITES = 40; // Cloudflare free tier: 50 subrequest limit

  for (const activity of activities) {
    if (synced + created >= MAX_WRITES) break;
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
      if (sport) props['Sport'] = { select: { name: sport.type } };

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
      if (sport) props['Sport'] = { select: { name: sport.type } };

      const createBody = { parent: { database_id: DB_ID }, properties: props };
      if (sport) createBody.icon = { type: 'emoji', emoji: sport.icon };
      await notionRequest(env, 'POST', '/pages', createBody);
      dateMap[date] = { id: 'new' };
      created++;
    }
  }

  return json({ synced, created, total: activities.length, capped: synced + created >= MAX_WRITES });
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

// ── Prinsipper (Notion-backed) ────────────────────────────────────────────────

async function getPrinsipper(env) {
  const res = await notionRequest(env, 'POST', `/databases/${DB_ID}/query`, {
    filter: { property: 'Navn', title: { equals: 'Fase-prinsipper' } },
    page_size: 1,
  });
  const data = await res.json();
  const page = data.results?.[0];
  if (!page) return json({ tekst: '', id: null });
  const tekst = page.properties['Vurdering']?.rich_text?.[0]?.plain_text || '';
  return json({ tekst, id: page.id });
}

async function savePrinsipper(env, tekst) {
  // Check if page already exists
  const findRes = await notionRequest(env, 'POST', `/databases/${DB_ID}/query`, {
    filter: { property: 'Navn', title: { equals: 'Fase-prinsipper' } },
    page_size: 1,
  });
  const findData = await findRes.json();
  const existing = findData.results?.[0];

  const props = {
    'Vurdering': { rich_text: [{ text: { content: tekst } }] },
  };

  if (existing) {
    await notionRequest(env, 'PATCH', `/pages/${existing.id}`, { properties: props });
    return json({ ok: true, id: existing.id });
  } else {
    const body = {
      parent: { database_id: DB_ID },
      properties: {
        'Navn': { title: [{ text: { content: 'Fase-prinsipper' } }] },
        ...props,
      },
      icon: { type: 'emoji', emoji: '📌' },
    };
    const res = await notionRequest(env, 'POST', '/pages', body);
    const data = await res.json();
    return json({ ok: true, id: data.id });
  }
}

// ── Google Calendar ───────────────────────────────────────────────────────────

async function refreshGoogleToken(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new Error('Google Calendar secrets ikke satt (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)');
  }
  const form = new FormData();
  form.append('client_id',     env.GOOGLE_CLIENT_ID.trim());
  form.append('client_secret', env.GOOGLE_CLIENT_SECRET.trim());
  form.append('refresh_token', env.GOOGLE_REFRESH_TOKEN.trim());
  form.append('grant_type',    'refresh_token');
  const res  = await fetch(GOOGLE_TOKEN_URL, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.access_token) throw new Error('Google token feil: ' + JSON.stringify(data));
  return data.access_token;
}

function googleRequest(accessToken, method, path, body) {
  return fetch(`${GOOGLE_CAL_API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function getCalendarEvents(env, from, to) {
  try {
    const token = await refreshGoogleToken(env);
    const calId = encodeURIComponent(env.GOOGLE_CALENDAR_ID?.trim() || 'primary');
    const timeMin = encodeURIComponent(from + 'T00:00:00Z');
    const timeMax = encodeURIComponent(to   + 'T23:59:59Z');
    const res  = await googleRequest(token, 'GET',
      `/calendars/${calId}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`);
    const data = await res.json();
    if (!res.ok) return json({ error: 'GCal feil', detail: data }, 500);
    const events = (data.items || []).map(e => ({
      id:          e.id,
      title:       e.summary || '',
      date:        e.start?.date || e.start?.dateTime?.split('T')[0] || '',
      description: e.description || '',
    }));
    return json({ events });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function createPlanSessions(env, sessions) {
  if (!sessions.length) return json({ created: 0, notionIds: [], calendarIds: [] });
  const capped = sessions.slice(0, 7); // max 7 to stay under subrequest limit

  let token;
  try { token = await refreshGoogleToken(env); } catch (_) { token = null; }

  const calId = encodeURIComponent(env.GOOGLE_CALENDAR_ID?.trim() || 'primary');
  const notionIds = [], calendarIds = [];
  let created = 0;

  for (const s of capped) {
    const sport = s.sport || '';
    const notionSport = Object.values(SPORT_MAP).find(v => sport.includes(v.icon));

    // Notion page
    const props = {
      'Navn':  { title: [{ text: { content: s.navn || 'Planlagt økt' } }] },
      'Dato':  { date:  { start: s.dato } },
      'Status': { select: { name: 'To Do' } },
    };
    if (s.type)         props['Type']            = { select: { name: s.type } };
    if (s.varighet)     props['Varighet (min)']  = { number: Number(s.varighet) };
    if (s.planlagtPuls) props['Planlagt puls']   = { rich_text: [{ text: { content: s.planlagtPuls } }] };
    if (notionSport)    props['Sport']           = { select: { name: notionSport.type } };

    const createBody = { parent: { database_id: DB_ID }, properties: props };
    if (notionSport) createBody.icon = { type: 'emoji', emoji: notionSport.icon };

    const nRes  = await notionRequest(env, 'POST', '/pages', createBody);
    const nData = await nRes.json();
    if (nData.id) notionIds.push(nData.id);

    // GCal event
    if (token) {
      const sportEmoji = sport.split(' ')[0] || '';
      const descLines = [
        s.type         ? `Type: ${s.type}`           : '',
        s.planlagtPuls ? `Mål-HR: ${s.planlagtPuls}` : '',
        s.varighet     ? `Varighet: ${s.varighet} min`: '',
        '',
        s.beskrivelse  || '',
      ].filter((l, i) => i >= 3 || l).join('\n').trim();

      // next-day end date for GCal all-day event
      const endDate = new Date(s.dato);
      endDate.setDate(endDate.getDate() + 1);
      const endStr = endDate.toISOString().split('T')[0];

      const event = {
        summary: [sportEmoji, s.navn].filter(Boolean).join(' '),
        description: descLines,
        start: { date: s.dato },
        end:   { date: endStr },
        colorId: TYPE_COLOR[s.type] || '2',
        extendedProperties: { private: { source: 'trening-arnar' } },
      };
      const gRes  = await googleRequest(token, 'POST', `/calendars/${calId}/events`, event);
      const gData = await gRes.json();
      if (gData.id) calendarIds.push(gData.id);
    }

    created++;
  }

  return json({ created, notionIds, calendarIds });
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
    sport: p['Sport']?.select?.name || '',
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
  if (body.sport)    props['Sport']    = { select: { name: body.sport } };
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
