/**
 * Cloudflare Worker — Notion proxy for Treningsdashboard
 * Lagre NOTION_TOKEN som secret i Cloudflare dashboard
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const DB_ID = '953ee9299ea345fb8a3d77cf8237116a';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /api/okter — hent alle økter fra Notion
      if (path === '/api/okter' && request.method === 'GET') {
        const res = await notionRequest(env, 'POST', `/databases/${DB_ID}/query`, {
          sorts: [{ property: 'Dato', direction: 'descending' }],
          page_size: 100,
        });
        const data = await res.json();
        if (!res.ok || !data.results) {
          return json({ error: 'Notion feil', detail: data }, res.status || 500);
        }
        const okter = data.results.map(mapPage);
        return json({ okter });
      }

      // PATCH /api/okter/:id — oppdater en økt
      if (path.startsWith('/api/okter/') && request.method === 'PATCH') {
        const pageId = path.replace('/api/okter/', '');
        const body = await request.json();
        const props = buildNotionProps(body);
        const res = await notionRequest(env, 'PATCH', `/pages/${pageId}`, { properties: props });
        const data = await res.json();
        return json({ ok: true, id: data.id });
      }

      // POST /api/okter — opprett ny økt
      if (path === '/api/okter' && request.method === 'POST') {
        const body = await request.json();
        const props = buildNotionProps(body);
        if (body.navn) {
          props['Navn'] = { title: [{ text: { content: body.navn } }] };
        }
        const res = await notionRequest(env, 'POST', '/pages', {
          parent: { database_id: DB_ID },
          properties: props,
        });
        const data = await res.json();
        return json({ ok: true, id: data.id });
      }

      // POST /api/analyse — kall Claude API
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
            model: 'claude-sonnet-4-20250514',
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
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  if (body.status) props['Status'] = { select: { name: body.status } };
  if (body.type)   props['Type']   = { select: { name: body.type } };
  if (body.fase)   props['Fase']   = { select: { name: body.fase } };
  if (body.vurdering !== undefined) props['Vurdering'] = { rich_text: [{ text: { content: body.vurdering } }] };
  if (body.pace !== undefined)      props['Pace']      = { rich_text: [{ text: { content: body.pace } }] };
  if (body.planlagtPuls !== undefined) props['Planlagt puls'] = { rich_text: [{ text: { content: body.planlagtPuls } }] };
  if (body.faktiskSnittHR != null)  props['Faktisk snitt HR'] = { number: body.faktiskSnittHR };
  if (body.faktiskMaksHR != null)   props['Faktisk maks HR']  = { number: body.faktiskMaksHR };
  if (body.varighet != null)        props['Varighet (min)']   = { number: body.varighet };
  if (body.smerte != null)          props['Smerte 0-10']      = { number: body.smerte };
  if (body.medVogn !== undefined)   props['Med vogn']         = { checkbox: body.medVogn };
  if (body.dato)   props['Dato'] = { date: { start: body.dato } };
  return props;
}
