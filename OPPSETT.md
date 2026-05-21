# Oppsett — Treningsdashboard

## Hva du får
- `worker.js` — Cloudflare Worker (proxy mot Notion + Claude API)
- `index.html` — dashbordet (PC + mobil)
- Henter alltid live data fra Notion ved oppstart
- Null manuelt arbeid etter oppsett

---

## Steg 1 — GitHub repo (2 min)

1. Gå til https://github.com/new
2. Navn: `trening`  
3. Visibility: **Private**
4. Create repository
5. Last opp begge filene (`worker.js`, `index.html`, `wrangler.toml`)

---

## Steg 2 — Cloudflare Worker (5 min)

### 2a — Opprett konto
Gå til https://dash.cloudflare.com — gratis konto.

### 2b — Deploy Worker
```bash
# Installer Wrangler CLI
npm install -g wrangler

# Logg inn
wrangler login

# Gå til mappen
cd trening-app

# Deploy
wrangler deploy
```

Du får en URL: `https://trening-arnar.<din-id>.workers.dev`

### 2c — Legg til secrets (aldri i koden)
```bash
wrangler secret put NOTION_TOKEN
# Lim inn: secret_xxxxxxxxxxxxxxxxxxxx

wrangler secret put CLAUDE_API_KEY  
# Lim inn: sk-ant-xxxxxxxxxxxx
```

Ferdig — Worker er live.

---

## Steg 3 — GitHub Pages for index.html (2 min)

1. Gå til repo → Settings → Pages
2. Source: Deploy from branch → main → / (root)
3. Save

URL: `https://<ditt-brukernavn>.github.io/trening/index.html`

---

## Steg 4 — Konfigurer dashbordet (1 min)

1. Åpne URL-en i nettleseren
2. Gå til ⚙️ Innstillinger
3. Lim inn Worker URL: `https://trening-arnar.<din-id>.workers.dev`
4. Trykk "Test tilkobling" — skal vise antall økter

**Dette gjøres én gang per enhet** (lagres i localStorage).

---

## Steg 5 — Legg til på hjemskjermen

**iPhone (Safari):**
Del-knapp → "Legg til på hjemskjerm" → Trening

**Android (Chrome):**
Meny → "Legg til på startskjermen"

---

## Oppdatere dashbordet senere

Endre `index.html` → push til GitHub → Pages oppdateres automatisk innen 1 min.  
Worker-koden endres med `wrangler deploy`.  
Notion-data er alltid live — ingen deploy nødvendig.

---

## Notion Integration Token

Gå til https://notion.so/my-integrations:
1. "+ New integration"
2. Navn: "Treningsdashboard"
3. Kopier "Internal Integration Token" (secret_...)
4. Gå til Treningsøkter-databasen i Notion → ... → Connections → legg til integrasjonen

