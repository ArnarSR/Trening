const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const CLAUDE_MODEL = 'claude-sonnet-4-6';

// System prompt for structured session analysis
const COACH_SYSTEM_PROMPT = `\
Du er en personlig treningscoach med doktorgrad i sportsfysiologi og bred praktisk erfaring med \
utholdenhetsidretter. Din ekspertise dekker:

• Periodisering og progressiv overbelastning — akutt:kronisk belastningsratio, superkompensasjon
• HR-sonebasert trening (Z1–Z5): aerob base, laktatterskel, VO2max-intervaller
• Restitusjonsfysiologi: HRV-tolkning, søvnarkitektur (dyp/REM/lett), hormonstatus
• Rehabilitering og skadesforebygging — særlig hofte, kne og bekkenmuskulatur
• Individualisert planlegging som vekter total livsbelastning, ikke bare treningsbelastning

Retningslinjer du alltid følger:
• Lav HRV + fragmentert søvn = reduser intensitet, uansett plan. Ingen unntak.
• Smerte > 3 på en økt = anbefal hvile eller alternativ trening neste gang
• Aldri anbefal to harde økter på rad uten restitusjonøkt imellom
• Vær direkte og konkret — unngå vage fraser som "lytt til kroppen"

Lengdekrav per felt — overhold disse:
• summary: maks 2 setninger
• loadAssessment: ett ord + én setning (f.eks. "Moderat — intensiteten var kontrollert")
• recoveryStatus: én setning
• nextSessionRecommendation: én konkret setning med type, varighet og intensitet
• motivation: én setning, maks 15 ord

Du svarer ALLTID med gyldig JSON og INGEN ANNEN TEKST. Nøyaktig dette formatet:
{"summary":"...","loadAssessment":"...","recoveryStatus":"...","nextSessionRecommendation":"...","motivation":"..."}\
`;

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
  yoga:             { type: '🧘 Yoga',            icon: '🧘' },
  pilates:          { type: '🧘 Yoga',            icon: '🧘' },
  elliptical:       { type: '💪 Styrke',          icon: '💪' },
  rowing:           { type: '🚣 Roing',           icon: '🚣' },
  virtualrow:       { type: '🚣 Roing',           icon: '🚣' },
  alpineski:        { type: '⛷️ Alpint',          icon: '⛷️' },
  inlineskate:      { type: '🛼 Rulleskøyter',   icon: '🛼' },
  standuppaddling:  { type: '🏄 SUP',             icon: '🏄' },
  soccer:           { type: '⚽ Fotball',          icon: '⚽' },
  tennis:           { type: '🎾 Tennis',           icon: '🎾' },
  crossfit:         { type: '💪 Styrke',          icon: '💪' },
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    try {
      // GET /api/okter — paginated cursor loop
      if (path === '/api/okter' && request.method === 'GET') {
        const pages = [];
        let cursor;
        do {
          const body = {
            sorts: [{ property: 'Dato', direction: 'descending' }],
            page_size: 100,
          };
          if (cursor) body.start_cursor = cursor;
          const res = await notionRequest(env, 'POST', `/databases/${env.DB_ID}/query`, body);
          const data = await res.json();
          if (!res.ok || !data.results) {
            return json({ error: 'Notion feil', detail: data }, res.status || 500);
          }
          pages.push(...data.results);
          cursor = data.has_more ? data.next_cursor : null;
        } while (cursor);
        return json({ okter: pages.map(mapPage) });
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
        if (!res.ok) return json({ error: 'Notion feil', detail: data }, res.status || 500);
        return json({ ok: true, id: data.id });
      }

      // POST /api/okter
      if (path === '/api/okter' && request.method === 'POST') {
        const body = await request.json();
        const props = buildNotionProps(body);
        if (body.navn) {
          props['Navn'] = { title: [{ text: { content: body.navn } }] };
        }
        const createBody = { parent: { database_id: env.DB_ID }, properties: props };
        if (body.icon) createBody.icon = { type: 'emoji', emoji: body.icon };
        const res = await notionRequest(env, 'POST', '/pages', createBody);
        const data = await res.json();
        if (!res.ok) return json({ error: 'Notion feil', detail: data }, res.status || 500);
        return json({ ok: true, id: data.id });
      }

      // GET /api/settings
      if (path === '/api/settings' && request.method === 'GET') {
        const val = await env.SETTINGS.get('sports_settings');
        return json(val ? JSON.parse(val) : { active: [], focus: null });
      }

      // POST /api/settings
      if (path === '/api/settings' && request.method === 'POST') {
        const body = await request.json();
        const existing = await env.SETTINGS.get('sports_settings');
        const current = existing ? JSON.parse(existing) : {};
        await env.SETTINGS.put('sports_settings', JSON.stringify({ ...current, ...body }));
        return json({ ok: true });
      }

      // GET /api/prinsipper
      if (path === '/api/prinsipper' && request.method === 'GET') {
        return getNamedPage(env, 'Fase-prinsipper');
      }

      // POST /api/prinsipper
      if (path === '/api/prinsipper' && request.method === 'POST') {
        const { tekst } = await request.json();
        return saveNamedPage(env, 'Fase-prinsipper', tekst || '', '📌');
      }

      // GET /api/kontekst
      if (path === '/api/kontekst' && request.method === 'GET') {
        return getNamedPage(env, 'Treningskontekst');
      }

      // POST /api/kontekst
      if (path === '/api/kontekst' && request.method === 'POST') {
        const { tekst } = await request.json();
        return saveNamedPage(env, 'Treningskontekst', tekst || '', '🧠');
      }

      // GET /api/goals
      if (path === '/api/goals' && request.method === 'GET') {
        const res = await notionRequest(env, 'POST', `/databases/${env.DB_ID}/query`, {
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
        const createBody = { parent: { database_id: env.DB_ID }, properties: props, icon: { type: 'emoji', emoji: icon } };
        const res  = await notionRequest(env, 'POST', '/pages', createBody);
        const data = await res.json();
        if (!res.ok) return json({ error: 'Notion feil', detail: data }, res.status || 500);
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
        const createBody = { parent: { database_id: env.DB_ID }, properties: props, icon: { type: 'emoji', emoji: body.icon || '📝' } };
        const res  = await notionRequest(env, 'POST', '/pages', createBody);
        const data = await res.json();
        if (!res.ok) return json({ error: 'Notion feil', detail: data }, res.status || 500);
        return json({ ok: true, id: data.id });
      }

      // GET /api/helse
      if (path === '/api/helse' && request.method === 'GET') {
        const res = await notionRequest(env, 'POST', `/databases/${env.HELSE_DB_ID}/query`, {
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
        const existing = await notionRequest(env, 'POST', `/databases/${env.HELSE_DB_ID}/query`, {
          filter: { property: 'Dato', date: { equals: dato } },
          page_size: 1,
        });
        const existData = await existing.json();
        const existPage = existData.results?.[0];

        if (existPage) {
          const res = await notionRequest(env, 'PATCH', `/pages/${existPage.id}`, { properties: buildHelseProps(body) });
          const data = await res.json();
          if (!res.ok) return json({ error: 'Notion feil', detail: data }, res.status || 500);
          return json({ ok: true, id: data.id, updated: true });
        }

        const res = await notionRequest(env, 'POST', '/pages', {
          parent: { database_id: env.HELSE_DB_ID }, properties: buildHelseProps(body),
        });
        const data = await res.json();
        if (!res.ok) return json({ error: 'Notion feil', detail: data }, res.status || 500);
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

      // GET /api/debug/last-activity
      if (path === '/api/debug/last-activity' && request.method === 'GET') {
        return debugLastActivity(env);
      }

      // POST /api/analyse
      if (path === '/api/analyse' && request.method === 'POST') {
        const body = await request.json();
        const ts = new Date().toISOString();
        const isStructured = !!(body.okt || body.sovn || body.hrv);

        if (isStructured) {
          // Validate: require at least type or varighet on the session
          if (!body.okt || (!body.okt.type && body.okt.varighet == null)) {
            return json({
              error: 'Mangler økt-data: okt.type eller okt.varighet er påkrevd',
              fields: { okt: 'type eller varighet må være satt' },
            }, 400);
          }

          const { okt, sovn, hrv, historikk } = body;

          console.log(JSON.stringify({
            ts, endpoint: '/api/analyse', mode: 'structured',
            input: {
              oktType: okt.type, oktSport: okt.sport, varighet: okt.varighet,
              harSovn: !!sovn, harHRV: !!hrv, historikkDager: historikk?.length || 0,
            },
          }));

          const userMessage = buildStructuredMessage(okt, sovn, hrv, historikk);
          const rawText = await callClaude(env, {
            system: COACH_SYSTEM_PROMPT,
            userMessage,
            maxTokens: 900,
          });
          const result = parseStructuredResponse(rawText);

          console.log(JSON.stringify({
            ts, endpoint: '/api/analyse', mode: 'structured',
            status: result.ok ? 'ok' : 'parse_error',
            responseLen: rawText.length,
          }));

          if (result.ok) return json(result.data);
          // Fallback: surface full raw text in summary if JSON parse failed
          return json({
            summary: rawText,
            loadAssessment: '—', recoveryStatus: '—',
            nextSessionRecommendation: '—', motivation: '—',
          });
        }

        // Legacy free-form mode — used by all existing frontend calls
        if (!body.prompt || typeof body.prompt !== 'string' || !body.prompt.trim()) {
          return json({
            error: 'Mangler prompt eller strukturert økt-data (okt, sovn, hrv)',
          }, 400);
        }

        console.log(JSON.stringify({
          ts, endpoint: '/api/analyse', mode: 'legacy',
          promptLen: body.prompt.length,
        }));

        const text = await callClaude(env, {
          userMessage: body.prompt,
          maxTokens: 4000,
        });

        console.log(JSON.stringify({
          ts, endpoint: '/api/analyse', mode: 'legacy',
          status: 'ok', responseLen: text.length,
        }));

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
  const newest = dates[dates.length - 1];

  console.log(JSON.stringify({
    ts: new Date().toISOString(), event: 'sync_start',
    total: activities.length, oldest, newest,
  }));

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

  let synced = 0, created = 0, errors = 0;
  const MAX_WRITES = 40; // Cloudflare free tier: 50 subrequest limit

  for (const activity of activities) {
    if (synced + created + errors >= MAX_WRITES) break;
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

    console.log(JSON.stringify({
      ts: new Date().toISOString(), event: 'sync_activity',
      stravaId, date, name, sportKey, action: existing ? 'update' : 'create',
    }));

    if (existing) {
      const pageId = existing.id;
      const props = {
        // Mark Strava-confirmed sessions as completed, even if they were planned
        'Status': { select: { name: 'Gjennomført' } },
      };
      if (avgHR !== null)    props['Faktisk snitt HR'] = { number: avgHR };
      if (maxHR !== null)    props['Faktisk maks HR']  = { number: maxHR };
      if (duration !== null) props['Varighet (min)']   = { number: duration };
      if (distance !== null) props['Distanse (km)']    = { number: distance };
      if (pace)              props['Pace']              = { rich_text: [{ text: { content: pace } }] };
      if (sport)             props['Sport']             = { select: { name: sport.type } };
      props['Strava ID'] = { rich_text: [{ text: { content: stravaId } }] };

      const patchBody = { properties: props };
      if (sport) patchBody.icon = { type: 'emoji', emoji: sport.icon };
      const patchRes = await notionRequest(env, 'PATCH', `/pages/${pageId}`, patchBody);
      const patchData = await patchRes.json();
      if (!patchRes.ok) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'sync_patch_error', stravaId, date, error: patchData }));
        errors++;
        continue;
      }
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

      const createBody = { parent: { database_id: env.DB_ID }, properties: props };
      if (sport) createBody.icon = { type: 'emoji', emoji: sport.icon };
      const newPage = await notionRequest(env, 'POST', '/pages', createBody);
      const newData = await newPage.json();
      if (!newPage.ok) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'sync_create_error', stravaId, date, name, sportKey, error: newData }));
        errors++;
        continue;
      }
      stravaMap[stravaId] = { id: newData.id || 'new' };
      created++;
    }
  }

  return json({ synced, created, errors, total: activities.length, capped: synced + created + errors >= MAX_WRITES });
}

async function debugLastActivity(env) {
  const form = new FormData();
  form.append('client_id', env.STRAVA_CLIENT_ID.trim());
  form.append('client_secret', env.STRAVA_CLIENT_SECRET.trim());
  form.append('refresh_token', env.STRAVA_REFRESH_TOKEN.trim());
  form.append('grant_type', 'refresh_token');
  const tokenRes = await fetch('https://www.strava.com/oauth/token', { method: 'POST', body: form });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return json({ error: 'Strava token feil', detail: tokenData }, 500);

  const actRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=5', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const activities = await actRes.json();
  if (!Array.isArray(activities) || !activities.length) return json({ error: 'Ingen aktiviteter', detail: activities });

  return json({
    activities: activities.map(a => {
      const sportKey = (a.sport_type || a.type || '').toLowerCase();
      const sport = SPORT_MAP[sportKey];
      return {
        raw: {
          id: a.id,
          name: a.name,
          sport_type: a.sport_type,
          type: a.type,
          start_date: a.start_date,
          start_date_local: a.start_date_local,
          elapsed_time: a.elapsed_time,
          distance: a.distance,
          average_speed: a.average_speed,
          average_heartrate: a.average_heartrate,
          max_heartrate: a.max_heartrate,
        },
        mapped: {
          stravaId: String(a.id),
          sportKey,
          sportFound: !!sport,
          sport: sport?.type || null,
          date: a.start_date_local?.split('T')[0],
          duration: a.elapsed_time ? Math.round(a.elapsed_time / 60) : null,
          distance: a.distance ? Math.round(a.distance / 100) / 10 : null,
          pace: a.average_speed > 0 ? formatPace(a.average_speed) : null,
          avgHR: a.average_heartrate ? Math.round(a.average_heartrate) : null,
        },
      };
    }),
  });
}

function requireAuth(request, env) {
  if (!env.API_TOKEN) return null; // not configured — allow all (opt-in)
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== env.API_TOKEN) return json({ error: 'Unauthorized' }, 401);
  return null;
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
    const res = await notionRequest(env, 'POST', `/databases/${env.DB_ID}/query`, body);
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

// ── Named page helpers (Notion-backed) ───────────────────────────────────────

async function getNamedPage(env, navn) {
  const res = await notionRequest(env, 'POST', `/databases/${env.DB_ID}/query`, {
    filter: { property: 'Navn', title: { equals: navn } },
    page_size: 1,
  });
  const data = await res.json();
  const page = data.results?.[0];
  if (!page) return json({ tekst: '', id: null });
  return json({ tekst: page.properties['Vurdering']?.rich_text?.[0]?.plain_text || '', id: page.id });
}

async function saveNamedPage(env, navn, tekst, ikon = '📌') {
  const findRes = await notionRequest(env, 'POST', `/databases/${env.DB_ID}/query`, {
    filter: { property: 'Navn', title: { equals: navn } },
    page_size: 1,
  });
  const existing = (await findRes.json()).results?.[0];
  const props = { 'Vurdering': { rich_text: [{ text: { content: tekst } }] } };

  if (existing) {
    const res = await notionRequest(env, 'PATCH', `/pages/${existing.id}`, { properties: props });
    const data = await res.json();
    if (!res.ok) return json({ error: 'Notion feil', detail: data }, 500);
    return json({ ok: true, id: existing.id });
  }

  const res = await notionRequest(env, 'POST', '/pages', {
    parent: { database_id: env.DB_ID },
    properties: { 'Navn': { title: [{ text: { content: navn } }] }, ...props },
    icon: { type: 'emoji', emoji: ikon },
  });
  const data = await res.json();
  if (!res.ok) return json({ error: 'Notion feil', detail: data }, 500);
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

    const createBody = { parent: { database_id: env.DB_ID }, properties: props };
    if (notionSport) createBody.icon = { type: 'emoji', emoji: notionSport.icon };

    const nRes  = await notionRequest(env, 'POST', '/pages', createBody);
    const nData = await nRes.json();
    if (!nRes.ok) { created++; continue; }
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
  if (body.medVogn !== undefined)
    props['Med vogn'] = { checkbox: body.medVogn };
  return props;
}

// ── Claude API helpers ────────────────────────────────────────────────────────

/**
 * Retry wrapper — retries on network failures and recoverable HTTP errors.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} maxAttempts
 * @param {number} delayMs
 * @returns {Promise<T>}
 */
async function withRetry(fn, maxAttempts = 2, delayMs = 1000) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

/**
 * Call the Claude API with retry on 429 / 5xx.
 * @param {object} env - Cloudflare env bindings
 * @param {{ system?: string, userMessage: string, maxTokens?: number }} opts
 * @returns {Promise<string>} - Raw text response
 */
async function callClaude(env, { system, userMessage, maxTokens = 600 }) {
  return withRetry(async () => {
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: userMessage }],
    };
    if (system) body.system = system;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    // Retry on rate limit or server errors
    if (res.status === 429 || res.status >= 500) {
      throw new Error(`Claude API returned ${res.status}`);
    }

    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Claude API error');
    return data.content?.find(b => b.type === 'text')?.text || '';
  });
}

/**
 * Build the structured user message from session, sleep, HRV and history.
 * @param {object} okt  - Session data
 * @param {object} [sovn] - Sleep data
 * @param {object} [hrv]  - HRV data
 * @param {object[]} [historikk] - Last 7 days
 * @returns {string}
 */
function buildStructuredMessage(okt, sovn, hrv, historikk) {
  const lines = ['## Treningsøkt'];

  if (okt.navn)           lines.push(`Navn: ${okt.navn}`);
  if (okt.type)           lines.push(`Type: ${okt.type}`);
  if (okt.sport)          lines.push(`Sport: ${okt.sport}`);
  if (okt.varighet)       lines.push(`Varighet: ${okt.varighet} min`);
  if (okt.faktiskSnittHR) lines.push(`Snitt-HR: ${okt.faktiskSnittHR} bpm`);
  if (okt.faktiskMaksHR)  lines.push(`Maks-HR: ${okt.faktiskMaksHR} bpm`);
  if (okt.pace)           lines.push(`Pace: ${okt.pace}/km`);
  if (okt.distanse)       lines.push(`Distanse: ${okt.distanse} km`);
  if (okt.smerte != null) lines.push(`Smerte (0–10): ${okt.smerte}`);
  if (okt.dato)           lines.push(`Dato: ${okt.dato}`);
  if (okt.vurdering)      lines.push(`Notater: ${okt.vurdering}`);
  if (okt.hrSoner?.length) {
    lines.push('HR-soner:');
    okt.hrSoner.forEach(z => lines.push(`  Sone ${z.zone}: ${z.minutter} min`));
  }

  if (sovn) {
    lines.push('', '## Søvn i natt');
    if (sovn.total    != null) lines.push(`Total: ${sovn.total} t`);
    if (sovn.dyp      != null) lines.push(`Dyp søvn: ${sovn.dyp} t`);
    if (sovn.rem      != null) lines.push(`REM: ${sovn.rem} t`);
    if (sovn.lett     != null) lines.push(`Lett søvn: ${sovn.lett} t`);
    if (sovn.score    != null) lines.push(`Score: ${sovn.score}/100`);
    if (sovn.kvalitet != null) {
      lines.push(`Subjektiv kvalitet: ${['', 'Dårlig', 'OK', 'Bra'][sovn.kvalitet] || sovn.kvalitet}`);
    }
  }

  if (hrv) {
    lines.push('', '## HRV');
    if (hrv.verdi    != null) lines.push(`Verdi: ${hrv.verdi} ms`);
    if (hrv.status)           lines.push(`Status: ${hrv.status}`);
    if (hrv.feedback)         lines.push(`Feedback: ${hrv.feedback}`);
  }

  if (historikk?.length) {
    lines.push('', '## Historikk (siste 7 dager)');
    historikk.forEach(h => {
      const parts = [`${h.dato}: ${h.sport || h.type || '—'}, ${h.varighet ?? '?'} min`];
      if (h.faktiskSnittHR) parts.push(`HR ${h.faktiskSnittHR}`);
      if (h.distanse)       parts.push(`${h.distanse} km`);
      if (h.smerte != null) parts.push(`smerte ${h.smerte}`);
      lines.push(parts.join(', '));
    });
  }

  return lines.join('\n');
}

/**
 * Parse Claude's JSON response into a structured result.
 * Strips markdown fences if present.
 * @param {string} text
 * @returns {{ ok: true, data: object } | { ok: false, raw: string }}
 */
function parseStructuredResponse(text) {
  const REQUIRED = ['summary', 'loadAssessment', 'recoveryStatus', 'nextSessionRecommendation', 'motivation'];

  const finalize = (parsed) => {
    REQUIRED.forEach(k => { if (!parsed[k]) parsed[k] = '—'; });
    return parsed;
  };

  // Strip markdown code fences (```json ... ```)
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

  // Attempt 1: parse the stripped text directly
  try {
    return { ok: true, data: finalize(JSON.parse(stripped)) };
  } catch { /* fall through */ }

  // Attempt 2: extract outermost JSON object by brace matching
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return { ok: true, data: finalize(JSON.parse(stripped.slice(start, end + 1))) };
    } catch { /* fall through */ }
  }

  return { ok: false, raw: text };
}
