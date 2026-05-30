// ── Notion API helpers ────────────────────────────────────────────────────────

const NOTION_API     = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export function notionReq(env, method, path, body) {
  return fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization:    `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type':   'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Paginate through all results of a database query. */
export async function queryAll(env, dbId, filter, sorts) {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts)  body.sorts  = sorts;
    if (cursor) body.start_cursor = cursor;
    const res  = await notionReq(env, 'POST', `/databases/${dbId}/query`, body);
    const data = await res.json();
    if (!res.ok) throw new Error(`Notion query failed: ${JSON.stringify(data)}`);
    pages.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return pages;
}

export function mapPage(page) {
  const p = page.properties;
  return {
    id:             page.id,
    navn:           p['Navn']?.title?.[0]?.plain_text           || '',
    type:           p['Type']?.select?.name                     || '',
    sport:          p['Sport']?.select?.name                    || '',
    status:         p['Status']?.select?.name                   || '',
    fase:           p['Fase']?.select?.name                     || '',
    dato:           p['Dato']?.date?.start                      || '',
    planlagtPuls:   p['Planlagt puls']?.rich_text?.[0]?.plain_text || '',
    faktiskSnittHR: p['Faktisk snitt HR']?.number               ?? null,
    faktiskMaksHR:  p['Faktisk maks HR']?.number                ?? null,
    varighet:       p['Varighet (min)']?.number                 ?? null,
    distance:       p['Distanse (km)']?.number                  ?? null,
    pace:           p['Pace']?.rich_text?.[0]?.plain_text       || '',
    smerte:         p['Smerte 0-10']?.number                    ?? null,
    vurdering:      p['Vurdering']?.rich_text?.[0]?.plain_text  || '',
    stravaId:       p['Strava ID']?.rich_text?.[0]?.plain_text  || '',
    kalorier:       p['Kalorier']?.number                       ?? null,
  };
}

export function mapHelsePage(page) {
  const p = page.properties;
  return {
    id:           page.id,
    dato:         p['Dato']?.date?.start                      || '',
    sovnTimer:    p['Søvn (timer)']?.number                   ?? null,
    sovnKvalitet: p['Søvnkvalitet (1-3)']?.number             ?? null,
    protein:      p['Protein (porsjoner)']?.number            ?? null,
    energi:       p['Energinivå (1-5)']?.number               ?? null,
    vekt:         p['Vekt (kg)']?.number                      ?? null,
    hrv:          p['HRV (ms)']?.number                       ?? null,
    notat:        p['Notat']?.rich_text?.[0]?.plain_text       || '',
  };
}

export function sessionProps(body) {
  const p = {};
  const rt  = (v) => ({ rich_text: [{ text: { content: String(v) } }] });
  const num = (v) => ({ number: Number(v) });
  const sel = (v) => ({ select: { name: v } });

  if (body.status)          p['Status']          = sel(body.status);
  if (body.type)            p['Type']            = sel(body.type);
  if (body.sport)           p['Sport']           = sel(body.sport);
  if (body.fase)            p['Fase']            = sel(body.fase);
  if (body.dato)            p['Dato']            = { date: { start: body.dato } };
  if (body.vurdering  != null) p['Vurdering']    = rt(body.vurdering);
  if (body.pace       != null) p['Pace']         = rt(body.pace);
  if (body.planlagtPuls != null) p['Planlagt puls'] = rt(body.planlagtPuls);
  if (body.faktiskSnittHR != null) p['Faktisk snitt HR'] = num(body.faktiskSnittHR);
  if (body.faktiskMaksHR  != null) p['Faktisk maks HR']  = num(body.faktiskMaksHR);
  if (body.varighet   != null) p['Varighet (min)']       = num(body.varighet);
  if (body.smerte     != null) p['Smerte 0-10']          = num(body.smerte);
  if (body.kalorier   != null) p['Kalorier']             = num(body.kalorier);
  if (body.stravaId   != null) p['Strava ID']            = rt(body.stravaId);
  if (body.medVogn    != null) p['Med vogn']             = { checkbox: !!body.medVogn };
  return p;
}
