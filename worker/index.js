const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const DB_ID = '953ee9299ea345fb8a3d77cf8237116a';
const HELSE_DB_ID = '2e5c1e0abf4e4fd69c4c88ae89c32d5f';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CAL_API   = 'https://www.googleapis.com/calendar/v3';

// GCal event color per type
const TYPE_COLOR = {
  'Sone 2': '2', 'Terskel': '5', 'Bakkeintervall': '11',
  'Race': '3', 'Styrke': '7', 'Rehab': '9', 'Testløp': '4',
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

      // GET /api/kontekst
      if (path === '/api/kontekst' && request.method === 'GET') {
        return getKontekst(env);
      }

      // POST /api/kontekst
      if (path === '/api/kontekst' && request.method === 'POST') {
        const { tekst } = await request.json();
        return saveKontekst(env, tekst || '');
      }

      // GET /api/goals
      if (path === '/api/goals' && request.method === 'GET') {
        const res = await notionRequest(env, 'POST', `/databases/${DB_ID}/query`, {
          filter: { or: [
            { property: 'Type', select: { equals: 'Race' } },
            { property: 'Type', select: { equals: 'Mål' } },
          ]},
          sorts: [{ property: 'Dato', direction: 'ascending' }],
          page_size: 50,
        });
        const data = await res.json();
        return json({ goals: (data.results || []).map(mapPage) });
      }

      // POST /api/goals
      if (path === '/api/goals' && request.method === 'POST') {
        const body = await request.json();
        const goalType = body.goalType || 'Race';
        const icon = goalType === 'Race' ? '🏁' : '🎯';
        const props = {
          'Navn':   { title: [{ text: { content: body.navn || 'Nytt mål' } }] },
          'Status': { select: { name: 'To Do' } },
          'Type':   { select: { name: goalType } },
        };
        if (body.dato)        props['Dato']          = { date: { start: body.dato } };
        if (body.planlagtPuls) props['Planlagt puls'] = { rich_text: [{ text: { content: body.planlagtPuls } }] };
        if (body.vurdering)   props['Vurdering']     = { rich_text: [{ text: { content: body.vurdering } }] };
        const createBody = { parent: { database_id: DB_ID }, properties: props, icon: { type: 'emoji', emoji: icon } };
        const res  = await notionRequest(env, 'POST', '/pages', createBody);
        const data = await res.json();
        return json({ ok: true, id: data.id });
      }

      // POST /api/dagbok
      if (path === '/api/dagbok' && request.method === 'POST') {
        const body = await request.json();
        const props = {
          'Navn':   { title: [{ text: { content: body.navn || 'Dagboknote' } }] },
          'Dato':   { date: { start: body.dato } },
          'Type':   { select: { name: 'Dagbok' } },
          'Status': { select: { name: 'Gjennomført' } },
        };
        if (body.vurdering) props['Vurdering'] = { rich_text: [{ text: { content: body.vurdering } }] };
        if (body.smerte != null) props['Smerte 0-10'] = { number: body.smerte };
        if (body.vekt != null)   props['Vekt (kg)']   = { number: body.vekt };
        const createBody = { parent: { database_id: DB_ID }, properties: props, icon: { type: 'emoji', emoji: body.icon || '📝' } };
        const res  = await notionRequest(env, 'POST', '/pages', createBody);
        const data = await res.json();
        return json({ ok: true, id: data.id });
      }

      // GET /api/helse
      if (path === '/api/helse' && request.method === 'GET') {
        const res = await notionRequest(env, 'POST', `/databases/${HELSE_DB_ID}/query`, {
          sorts: [{ property: 'Dato', direction: 'descending' }],
          page_size: 30,
        });
        const data = await res.json();
        return json({ helse: (data.results || []).map(mapHelsePage) });
      }

      // POST /api/helse
      if (path === '/api/helse' && request.method === 'POST') {
        const body = await request.json();
        const dato = body.dato || new Date().toISOString().split('T')[0];

        // Build shared props
        const buildHelseProps = (b) => {
          const parts = [];
          if (b.sovnTimer   != null) parts.push(`😴 ${b.sovnTimer}t`);
          if (b.sovnKvalitet != null) parts.push(['','Dårlig','OK','Bra'][b.sovnKvalitet]||'');
          if (b.protein     != null) parts.push(`🥩 ${b.protein}P`);
          if (b.energi      != null) parts.push(`⚡${b.energi}/5`);
          const props = {
            'Name': { title: [{ text: { content: parts.join(' · ') || dato } }] },
            'Dato': { date: { start: dato } },
          };
          if (b.sovnTimer    != null) props['Søvn (timer)']        = { number: b.sovnTimer };
          if (b.sovnKvalitet != null) props['Søvnkvalitet (1-3)']  = { number: b.sovnKvalitet };
          if (b.protein      != null) props['Protein (porsjoner)'] = { number: b.protein };
          if (b.energi       != null) props['Energinivå (1-5)']    = { number: b.energi };
          if (b.vekt         != null) props['Vekt (kg)']            = { number: b.vekt };
          if (b.notat) props['Notat'] = { rich_text: [{ text: { content: b.notat } }] };
          return props;
        };

        // Check if an entry already exists for this date — PATCH it if so
        const existing = await notionRequest(env, 'POST', `/databases/${HELSE_DB_ID}/query`, {
          filter: { property: 'Dato', date: { equals: dato } },
          page_size: 1,
        });
        const existData = await existing.json();
        const existPage = existData.results?.[0];

        if (existPage) {
          const res = await notionRequest(env, 'PATCH', `/pages/${existPage.id}`, { properties: buildHelseProps(body) });
          const data = await res.json();
          return json({ ok: true, id: data.id, updated: true });
        }

        const res = await notionRequest(env, 'POST', '/pages', {
          parent: { database_id: HELSE_DB_ID }, properties: buildHelseProps(body),
        });
        const data = await res.json();
        return json({ ok: true, id: data.id, updated: false });
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

  // Build both stravaId map (primary) and date map (fallback for manually-created pages)
  const stravaMap = {};
  const dateMap = {};
  for (const page of notionPages) {
    const sid = page.properties['Strava ID']?.rich_text?.[0]?.plain_text;
    if (sid && !stravaMap[sid]) stravaMap[sid] = page;
    const dato = page.properties['Dato']?.date?.start;
    if (dato && !dateMap[dato]) dateMap[dato] = page;
  }

  let synced = 0, created = 0;
  const MAX_WRITES = 40; // Cloudflare free tier: 50 subrequest limit

  for (const activity of activities) {
    if (synced + created >= MAX_WRITES) break;
    const date = activity.start_date_local?.split('T')[0];
    if (!date) continue;

    const stravaId = String(activity.id);
    const sportKey = (activity.sport_type || activity.type || '').toLowerCase();
    const sport = SPORT_MAP[sportKey];
    const avgHR = activity.average_heartrate ? Math.round(activity.average_heartrate) : null;
    const maxHR = activity.max_heartrate ? Math.round(activity.max_heartrate) : null;
    const duration = activity.elapsed_time ? Math.round(activity.elapsed_time / 60) : null;
    const distance = activity.distance ? Math.round(activity.distance / 100) / 10 : null; // km, 1 decimal
    const pace = activity.average_speed > 0 ? formatPace(activity.average_speed) : null;
    const name = activity.name || 'Strava-økt';

    // Match by Strava ID first (exact dedup), fall back to date (catches manually-created sessions)
    const existing = stravaMap[stravaId] || dateMap[date];

    if (existing) {
      const pageId = existing.id;
      const props = {};
      if (avgHR !== null)    props['Faktisk snitt HR'] = { number: avgHR };
      if (maxHR !== null)    props['Faktisk maks HR']  = { number: maxHR };
      if (duration !== null) props['Varighet (min)']   = { number: duration };
      if (distance !== null) props['Distanse (km)']    = { number: distance };
      if (pace)              props['Pace']              = { rich_text: [{ text: { content: pace } }] };
      if (sport)             props['Sport']             = { select: { name: sport.type } };
      props['Strava ID'] = { rich_text: [{ text: { content: stravaId } }] };

      const patchBody = { properties: props };
      if (sport) patchBody.icon = { type: 'emoji', emoji: sport.icon };
      await notionRequest(env, 'PATCH', `/pages/${pageId}`, patchBody);
      // Register by stravaId so two-a-days don't collide via dateMap
      stravaMap[stravaId] = existing;
      delete dateMap[date]; // prevent a two-a-day from date-matching the same page
      synced++;
    } else {
      const props = {
        'Navn':      { title: [{ text: { content: name } }] },
        'Dato':      { date: { start: date } },
        'Status':    { select: { name: 'Gjennomført' } },
        'Strava ID': { rich_text: [{ text: { content: stravaId } }] },
      };
      if (avgHR !== null)    props['Faktisk snitt HR'] = { number: avgHR };
      if (maxHR !== null)    props['Faktisk maks HR']  = { number: maxHR };
      if (duration !== null) props['Varighet (min)']   = { number: duration };
      if (distance !== null) props['Distanse (km)']    = { number: distance };
      if (pace)              props['Pace']              = { rich_text: [{ text: { content: pace } }] };
      if (sport)             props['Sport']             = { select: { name: sport.type } };

      const createBody = { parent: { database_id: DB_ID }, properties: props };
      if (sport) createBody.icon = { type: 'emoji', emoji: sport.icon };
      const newPage = await notionRequest(env, 'POST', '/pages', createBody);
      const newData = await newPage.json();
      stravaMap[stravaId] = { id: newData.id || 'new' };
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

async function getKontekst(env) {
  const res = await notionRequest(env, 'POST', `/databases/${DB_ID}/query`, {
    filter: { property: 'Navn', title: { equals: 'Treningskontekst' } },
    page_size: 1,
  });
  const data = await res.json();
  const page = data.results?.[0];
  if (!page) return json({ tekst: '', id: null });
  return json({ tekst: page.properties['Vurdering']?.rich_text?.[0]?.plain_text || '', id: page.id });
}

async function saveKontekst(env, tekst) {
  const findRes  = await notionRequest(env, 'POST', `/databases/${DB_ID}/query`, {
    filter: { property: 'Navn', title: { equals: 'Treningskontekst' } }, page_size: 1,
  });
  const existing = (await findRes.json()).results?.[0];
  const props    = { 'Vurdering': { rich_text: [{ text: { content: tekst } }] } };
  if (existing) {
    await notionRequest(env, 'PATCH', `/pages/${existing.id}`, { properties: props });
    return json({ ok: true, id: existing.id });
  }
  const res  = await notionRequest(env, 'POST', '/pages', {
    parent: { database_id: DB_ID },
    properties: { 'Navn': { title: [{ text: { content: 'Treningskontekst' } }] }, ...props },
    icon: { type: 'emoji', emoji: '🧠' },
  });
  const data = await res.json();
  return json({ ok: true, id: data.id });
}

// ── Google Calendar ───────────────────────────────────────────────────────────

async function getServiceAccountToken(env) {
  const email  = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = env.GOOGLE_PRIVATE_KEY;
  if (!email || !rawKey) throw new Error('Google service account secrets ikke satt (GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY)');

  const now = Math.floor(Date.now() / 1000);
  const b64url = obj => btoa(JSON.stringify(obj))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const sigInput = `${b64url(header)}.${b64url(payload)}`;

  // Handle both literal \n (from wrangler secret) and real newlines
  const pem     = rawKey.replace(/\\n/g, '\n');
  const keyB64  = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const keyBytes = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig    = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

  const jwt = `${sigInput}.${sigB64}`;
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
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
    const token = await getServiceAccountToken(env);
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
  try { token = await getServiceAccountToken(env); } catch (_) { token = null; }

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
    distance: p['Distanse (km)']?.number || null,
    pace: p['Pace']?.rich_text?.[0]?.plain_text || '',
    smerte: p['Smerte 0-10']?.number ?? null,
    vekt: p['Vekt (kg)']?.number || null,
    medVogn: p['Med vogn']?.checkbox || false,
    vurdering: p['Vurdering']?.rich_text?.[0]?.plain_text || '',
    stravaId: p['Strava ID']?.rich_text?.[0]?.plain_text || '',
    url: page.url,
  };
}

function mapHelsePage(page) {
  const p = page.properties;
  return {
    id: page.id,
    dato: p['Dato']?.date?.start || '',
    sovnTimer:    p['Søvn (timer)']?.number       ?? null,
    sovnKvalitet: p['Søvnkvalitet (1-3)']?.number ?? null,
    protein:      p['Protein (porsjoner)']?.number ?? null,
    energi:       p['Energinivå (1-5)']?.number    ?? null,
    vekt:         p['Vekt (kg)']?.number            ?? null,
    notat:        p['Notat']?.rich_text?.[0]?.plain_text || '',
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
  if (body.vekt != null)
    props['Vekt (kg)'] = { number: body.vekt };
  if (body.medVogn !== undefined)
    props['Med vogn'] = { checkbox: body.medVogn };
  return props;
}
