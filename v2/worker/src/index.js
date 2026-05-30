// ── Treningsdash v2 Worker ────────────────────────────────────────────────────
// Thin router. All business logic lives in athlete.js / coach.js.

import { setOrigin, corsHeaders, json, requireAuth } from './http.js';
import { notionReq, queryAll, mapPage, mapHelsePage, sessionProps } from './notion.js';
import {
  assembleState, getProfile, saveProfile, invalidateSessionCache, invalidateHealthCache,
  getSessions, computeReadiness, getRecentHealth,
} from './athlete.js';
import {
  getJournal, coachReadiness, coachDebrief, coachChat, coachPlan,
} from './coach.js';
import { syncStrava, syncLatestStrava } from './strava.js';

const SPORT_MAP = {
  run:'🏃 Løp', trailrun:'🏃 Løp', ride:'🚴 Sykkel', virtualride:'🚴 Sykkel',
  mountainbikeride:'🚵 Terrengsykkel', swim:'🏊 Svømming', hiking:'🥾 Fjelltur',
  walk:'🚶 Gåtur', backcountryski:'🎿 Randonee', nordicski:'⛷️ Langrenn',
  workout:'💪 Styrke', weighttraining:'💪 Styrke', yoga:'🧘 Yoga',
  pilates:'🧘 Yoga', elliptical:'💪 Styrke', rowing:'🚣 Roing',
  virtualrow:'🚣 Roing', alpineski:'⛷️ Alpint', crossfit:'💪 Styrke',
};

export default {
  async fetch(request, env) {
    setOrigin(env.ALLOWED_ORIGIN || 'https://arnarsr.github.io');

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders() });

    const url  = new URL(request.url);
    const path = url.pathname;
    const today = new Date().toISOString().split('T')[0];

    // ── Public ────────────────────────────────────────────────────────────────

    if (path === '/api/v2/version' && request.method === 'GET') {
      const version = env.DEPLOY_VERSION || 'dev';
      const key     = `v2_version_${version}`;
      let deployedAt = await env.KV.get(key);
      if (!deployedAt) {
        deployedAt = new Date().toISOString();
        await env.KV.put(key, deployedAt, { expirationTtl: 60 * 60 * 24 * 90 });
      }
      return json({ version, deployedAt });
    }

    // ── Auth gate ─────────────────────────────────────────────────────────────

    const authErr = requireAuth(request, env);
    if (authErr) return authErr;

    try {

      // ── Athlete state (read-only) ─────────────────────────────────────────

      // GET /api/v2/state — full athlete state (used by frontend on boot + refresh)
      if (path === '/api/v2/state' && request.method === 'GET') {
        const state = await assembleState(env, today);
        return json(state);
      }

      // ── Profile ───────────────────────────────────────────────────────────

      // GET /api/v2/profile
      if (path === '/api/v2/profile' && request.method === 'GET') {
        return json(await getProfile(env));
      }

      // PATCH /api/v2/profile
      if (path === '/api/v2/profile' && request.method === 'PATCH') {
        const patch = await request.json();
        return json(await saveProfile(env, patch));
      }

      // ── Sessions ──────────────────────────────────────────────────────────

      // GET /api/v2/sessions
      if (path === '/api/v2/sessions' && request.method === 'GET') {
        return json({ sessions: await getSessions(env) });
      }

      // POST /api/v2/sessions — create a session in Notion
      if (path === '/api/v2/sessions' && request.method === 'POST') {
        const body = await request.json();
        const props = {
          'Navn': { title: [{ text: { content: body.navn || 'Ny økt' } }] },
          ...sessionProps(body),
        };
        const icon = body.icon || '📅';
        const res  = await notionReq(env, 'POST', '/pages', {
          parent: { database_id: env.DB_ID }, properties: props,
          icon: { type: 'emoji', emoji: icon },
        });
        const data = await res.json();
        if (!res.ok) return json({ error: 'Notion feil', detail: data }, res.status || 500);
        await invalidateSessionCache(env);
        return json({ ok: true, id: data.id });
      }

      // PATCH /api/v2/sessions/:id
      if (path.match(/^\/api\/v2\/sessions\/[^/]+$/) && request.method === 'PATCH') {
        const id   = path.split('/').pop();
        const body = await request.json();
        const patchBody = { properties: sessionProps(body) };
        if (body.icon) patchBody.icon = { type: 'emoji', emoji: body.icon };
        const res  = await notionReq(env, 'PATCH', `/pages/${id}`, patchBody);
        const data = await res.json();
        if (!res.ok) return json({ error: 'Notion feil', detail: data }, res.status || 500);
        await invalidateSessionCache(env);
        return json({ ok: true });
      }

      // DELETE /api/v2/sessions/:id — archive in Notion
      if (path.match(/^\/api\/v2\/sessions\/[^/]+$/) && request.method === 'DELETE') {
        const id  = path.split('/').pop();
        const res = await notionReq(env, 'PATCH', `/pages/${id}`, { archived: true });
        if (!res.ok) return json({ error: 'Notion feil' }, res.status || 500);
        await invalidateSessionCache(env);
        return json({ ok: true });
      }

      // POST /api/v2/plan/apply — bulk create/update/delete from coach plan
      if (path === '/api/v2/plan/apply' && request.method === 'POST') {
        const { sessions: ops } = await request.json();
        const results = [];
        for (const op of (ops || [])) {
          if (op.action === 'delete' && op.notionId) {
            await notionReq(env, 'PATCH', `/pages/${op.notionId}`, { archived: true });
            results.push({ action: 'delete', id: op.notionId });
          } else if (op.action === 'update' && op.notionId) {
            const props = {
              ...sessionProps(op),
              ...(op.navn ? { 'Navn': { title: [{ text: { content: op.navn } }] } } : {}),
            };
            const patchBody = { properties: props };
            if (op.icon) patchBody.icon = { type: 'emoji', emoji: op.icon };
            if (op.beskrivelse) props['Vurdering'] = { rich_text: [{ text: { content: op.beskrivelse } }] };
            const res = await notionReq(env, 'PATCH', `/pages/${op.notionId}`, patchBody);
            const d   = await res.json();
            results.push({ action: 'update', id: d.id || op.notionId });
          } else if (op.action === 'create') {
            const navn  = op.navn || op.type || 'Ny økt';
            const props = {
              'Navn':   { title: [{ text: { content: navn } }] },
              'Status': { select: { name: 'To Do' } },
              ...sessionProps(op),
            };
            if (op.beskrivelse) props['Vurdering'] = { rich_text: [{ text: { content: op.beskrivelse } }] };
            const icon = op.icon || '📅';
            const res  = await notionReq(env, 'POST', '/pages', {
              parent: { database_id: env.DB_ID }, properties: props,
              icon: { type: 'emoji', emoji: icon },
            });
            const d = await res.json();
            results.push({ action: 'create', id: d.id });
          }
        }
        await invalidateSessionCache(env);
        return json({ ok: true, results });
      }

      // ── Health ────────────────────────────────────────────────────────────

      // POST /api/v2/health — upsert today's health entry
      if (path === '/api/v2/health' && request.method === 'POST') {
        const body = await request.json();
        const dato = body.dato || today;

        const buildProps = (b) => {
          const parts = [];
          if (b.sovnTimer   != null) parts.push(`😴 ${b.sovnTimer}t`);
          if (b.hrv         != null) parts.push(`HRV ${b.hrv}`);
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
          if (b.hrv          != null) props['HRV (ms)']             = { number: b.hrv };
          if (b.notat)               props['Notat']                 = { rich_text: [{ text: { content: b.notat } }] };
          return props;
        };

        const existing = await notionReq(env, 'POST', `/databases/${env.HELSE_DB_ID}/query`, {
          filter: { property: 'Dato', date: { equals: dato } }, page_size: 1,
        });
        const existData = await existing.json();
        const existPage = existData.results?.[0];

        if (existPage) {
          await notionReq(env, 'PATCH', `/pages/${existPage.id}`, { properties: buildProps(body) });
        } else {
          await notionReq(env, 'POST', '/pages', {
            parent: { database_id: env.HELSE_DB_ID }, properties: buildProps(body),
          });
        }

        await invalidateHealthCache(env);
        // Invalidate state cache so readiness is recomputed with new data
        await env.KV.delete(`v2_state_${today}`);
        return json({ ok: true });
      }

      // ── Coach ─────────────────────────────────────────────────────────────

      // GET /api/v2/coach/readiness — morning check-in
      if (path === '/api/v2/coach/readiness' && request.method === 'GET') {
        // Cache readiness response for the day (re-computed after health update)
        const cacheKey = `v2_readiness_${today}`;
        const cached   = await env.KV.get(cacheKey);
        if (cached) return json(JSON.parse(cached));

        const [state, journal] = await Promise.all([
          assembleState(env, today),
          getJournal(env),
        ]);
        const result = await coachReadiness(env, state, journal);
        await env.KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 3 * 60 * 60 }); // 3h
        return json(result);
      }

      // POST /api/v2/coach/debrief — post-session analysis
      if (path === '/api/v2/coach/debrief' && request.method === 'POST') {
        const { session } = await request.json();
        if (!session) return json({ error: 'session required' }, 400);
        const [state, journal] = await Promise.all([
          assembleState(env, today),
          getJournal(env),
        ]);
        return json(await coachDebrief(env, state, journal, session));
      }

      // POST /api/v2/coach/plan — generate or update plan
      if (path === '/api/v2/coach/plan' && request.method === 'POST') {
        const { request: userRequest } = await request.json();
        const [state, journal] = await Promise.all([
          assembleState(env, today),
          getJournal(env),
        ]);
        return json(await coachPlan(env, state, journal, userRequest || ''));
      }

      // POST /api/v2/coach/chat — free coach chat
      if (path === '/api/v2/coach/chat' && request.method === 'POST') {
        const { message, history } = await request.json();
        if (!message) return json({ error: 'message required' }, 400);
        const [state, journal] = await Promise.all([
          assembleState(env, today),
          getJournal(env),
        ]);
        return json(await coachChat(env, state, journal, message, history || []));
      }

      // GET /api/v2/coach/journal — read journal (for debug / settings)
      if (path === '/api/v2/coach/journal' && request.method === 'GET') {
        return json({ journal: await getJournal(env) });
      }

      // ── Strava sync ───────────────────────────────────────────────────────

      if (path === '/api/v2/sync' && request.method === 'POST')
        return syncStrava(env, SPORT_MAP, today);

      if (path === '/api/v2/sync-latest' && request.method === 'POST')
        return syncLatestStrava(env, SPORT_MAP, today);

      // ── Debug / cache management ──────────────────────────────────────────

      // DELETE /api/v2/cache — bust all caches (dev/admin use)
      if (path === '/api/v2/cache' && request.method === 'DELETE') {
        await Promise.all([
          env.KV.delete('v2_okter_cache'),
          env.KV.delete('v2_health_cache'),
          env.KV.delete(`v2_state_${today}`),
          env.KV.delete(`v2_readiness_${today}`),
        ]);
        return json({ ok: true });
      }

      return json({ error: 'Not found' }, 404);

    } catch (e) {
      console.error('v2 error', e.message, e.stack);
      return json({ error: e.message }, 500);
    }
  },
};
