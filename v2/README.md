# Treningsdash v2 — Arkitektur

## Kjernekonsepter

**Én atletmodell** — assembles server-side i Worker fra Notion + KV. Frontenden mottar ett ferdig state-objekt og renderer det. Den bygger aldri sin egen kontekst.

**Én trener** — ett system-prompt med hard physiologist-identitet, brukt av alle tre sløyfene. Ingen dupliserte prompt-byggere.

**Tre sløyfer:**
1. **Beredskap** (morgen) — `GET /api/v2/coach/readiness` — HRV + søvn + belastning → grønn/gul/rød + dagsprescription
2. **Debrief** (etter økt) — `POST /api/v2/coach/debrief` — intensitetstreff + smerte → journalnotis + neste-justeringsanbefaling
3. **Plan** (ukentlig/ved avvik) — `POST /api/v2/coach/plan` — ACWR + sonedistribusjon + mål → konkret plan med Notion-operasjoner

**Journalhukommelse** — treneren skriver beslutninger til `v2_journal` i KV (maks 8 entries, rolling). Alle tre sløyfer leser journalen. "Husker" hva den sa forrige uke.

**Intensitetsadherens** — måles per økt (faktiskSnittHR vs. planlagtPuls ± 5 bpm). Vises som % treff over siste 20 økter.

## Endepunkter

| Metode | Path | Beskrivelse |
|--------|------|-------------|
| GET | `/api/v2/version` | Deploy SHA + tidspunkt (public) |
| GET | `/api/v2/state` | Full atletmodell |
| GET | `/api/v2/profile` | Profil fra KV |
| PATCH | `/api/v2/profile` | Oppdater profil |
| GET | `/api/v2/sessions` | Alle Notion-sider |
| POST | `/api/v2/sessions` | Ny økt |
| PATCH | `/api/v2/sessions/:id` | Oppdater økt |
| DELETE | `/api/v2/sessions/:id` | Arkiver økt |
| POST | `/api/v2/plan/apply` | Bulk opprett/endre/slett fra plan |
| POST | `/api/v2/health` | Lagre/oppdater dagens helse |
| GET | `/api/v2/coach/readiness` | Beredskapsanalyse (cachet 3t) |
| POST | `/api/v2/coach/debrief` | Økt-debrief + journalnotat |
| POST | `/api/v2/coach/plan` | Lag/juster plan |
| POST | `/api/v2/coach/chat` | Fri coach-chat |
| GET | `/api/v2/coach/journal` | Les journal |
| POST | `/api/v2/sync` | Full Strava-sync |
| POST | `/api/v2/sync-latest` | Synk siste aktivitet |
| DELETE | `/api/v2/cache` | Bust alle cacher |

## KV-nøkler (v2_ prefix)

| Nøkkel | TTL | Innhold |
|--------|-----|---------|
| `v2_profile` | persistent | Atletprofil (maxHR, soner, skader, etc.) |
| `v2_journal` | persistent | Trener-journal (siste 8 entries) |
| `v2_okter_cache` | 5 min | Alle Notion-sider |
| `v2_health_cache` | 5 min | Helse siste 14 dager |
| `v2_state_{dato}` | 5 min | Full atletmodell |
| `v2_readiness_{dato}` | 3 timer | Beredskapsanalyse |
| `v2_version_{sha}` | 90 dager | Deploy-tidspunkt |

## Deploy

```bash
cd v2/worker
wrangler deploy --var DEPLOY_VERSION:$(git rev-parse HEAD)
```

Secrets settes én gang:
```bash
wrangler secret put NOTION_TOKEN
wrangler secret put CLAUDE_API_KEY
wrangler secret put API_TOKEN
wrangler secret put STRAVA_CLIENT_ID
wrangler secret put STRAVA_CLIENT_SECRET
wrangler secret put STRAVA_REFRESH_TOKEN
```

## Hva som er nytt vs v1

| Problem i v1 | Løsning i v2 |
|---|---|
| Kontekst bygget i nettleseren (5 steder, kan divergere) | Worker assembler full atletmodell |
| Profil/skade i localStorage — borte ved nytt device | Lagret i KV, frontend cacher lokalt |
| 5 dupliserte prompt-byggere | 1 system-prompt + 1 context-builder |
| Strukturert coach-prompt fantes men ble aldri brukt | Alle 4 coach-ops bruker same system-prompt |
| Ingen hukommelse (planHistory dør ved refresh) | Persistent journal i KV |
| `slice(-30)` sendte eldste, ikke nyeste økter | Alle slice-operasjoner server-side |
| Intensitetstreff bare kommentert, aldri målt | Beregnet per økt, lagret i state |
| Smerte aldri brukt som gate | Gate i readiness-beregning + coach-regler |
