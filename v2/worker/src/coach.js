// ── The Coach ─────────────────────────────────────────────────────────────────
// One system prompt. Three operations. Persistent journal memory.
//
// All three ops share the same COACH identity and receive the full athlete state,
// so the coach always has complete context regardless of which loop triggered it.

import { withRetry } from './http.js';

const MODEL      = 'claude-opus-4-8';
const JOURNAL_MAX = 8; // entries kept in rolling journal

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
Du er Arnar sin personlige treningscoach. Du har doktorgrad i sportsfysiologi og \
praktisk erfaring med utholdenhetsidretter og rehabilitering.

Din tilnærming:
• Du kjenner atleten godt — du leser alltid journalen og tilstanden før du svarer
• Du er direkte og konkret — aldri vage fraser som "lytt til kroppen"
• Du husker hva du sa forrige uke og holder atleten ansvarlig
• Du tenker helhetlig: løping + styrke + rehab + søvn + ernæring er ett system
• Smerte > 3 er alltid en hard gate — neste økt modifiseres, ingen unntak
• Lav HRV + dårlig søvn = senk intensitet, alltid, uansett plan

Intensitetsstyring:
• Planlagt puls-spenn er en kontrakt, ikke et forslag
• Treffer atleten >5 bpm over målsonen konsekvent → behandle som for hardt, utforsk årsak
• S3-sonen (for hard til å være lett, for lett til å gi terskeleffekt) er fellen — minimer den

Beredskapsprotokoll — signalfarger:
• Grønn (score ≥ 75): gjennomfør som planlagt
• Gul (score 50–74): reduser intensitet, behold varighet
• Rød (score < 50): bytt til lett aktivitet eller hvil

Ernæring (ett konkret tips per respons, aldri gram-beregninger):
✋ palmer = protein · 🤜 neve = karbo · 👍 tommel = fett · 👊 knyttneve = grønt

Svarstil:
• Vær kortfattet men fullstendig — si det viktigste først
• Bruk **fet tekst** for nøkkeltall og konkrete anbefalinger
• Avslutt alltid med én konkret handling atleten skal gjøre nå

Du er ikke en chatbot. Du er treneren. Handle deretter.\
`;

// ── Journal ───────────────────────────────────────────────────────────────────

/** Read the rolling coach journal (last N entries). */
export async function getJournal(env) {
  const raw = await env.KV.get('v2_journal');
  return raw ? JSON.parse(raw) : [];
}

/** Append a new journal entry and trim to JOURNAL_MAX. */
export async function appendJournal(env, entry) {
  const journal = await getJournal(env);
  journal.unshift({ ts: new Date().toISOString(), ...entry });
  const trimmed = journal.slice(0, JOURNAL_MAX);
  await env.KV.put('v2_journal', JSON.stringify(trimmed));
  return trimmed;
}

// ── Context builder ───────────────────────────────────────────────────────────

/**
 * Build the full context block sent as user message to Claude.
 * This replaces all five frontend prompt-builders in v1.
 */
function buildContext(state, journal, extra = '') {
  const { profile, readiness, metrics, sessions, goals, health, today } = state;

  // Profile block
  const sonerStr = profile.soner
    .map(z => `${z.n}: ${z.max === 999 ? z.min + '+' : z.min + '–' + z.max}`)
    .join(' | ');

  const profileBlock = [
    `Maks HR: ${profile.maxHR} bpm | Soner: ${sonerStr}`,
    `Fase: ${profile.faseNavn}`,
    profile.skader      ? `Skader/smerte: ${profile.skader}` : null,
    profile.rehabFokus  ? `Rehab-fokus: ${profile.rehabFokus}` : null,
    profile.fasiliteter ? `Fasiliteter: ${profile.fasiliteter}` : null,
    profile.kontekst    ? `\nUtøverprofil:\n${profile.kontekst}` : null,
    profile.fasePrinsipper ? `\nFase-prinsipper:\n${profile.fasePrinsipper}` : null,
  ].filter(Boolean).join('\n');

  // Readiness block
  const readinessBlock = [
    `Signal: ${readiness.signal.toUpperCase()} (score ${readiness.score}/100)`,
    `Foreskrevet: ${readiness.prescription}`,
    ...readiness.reasons.map(r => `• ${r}`),
  ].join('\n');

  // Load metrics
  const { acwr, zoneDist, adherence, painTrend } = metrics;
  const metricsBlock = [
    acwr.ratio != null
      ? `ACWR: ${acwr.ratio} (akutt ${acwr.acute} min / kronisk ${acwr.chronic} min/uke)`
      : 'ACWR: utilstrekkelig data',
    adherence.total > 0
      ? `Intensitetsadherens: ${adherence.rate}% treff (${adherence.hit}/${adherence.total}) — ${adherence.tooHard} for hardt, ${adherence.tooEasy} for lett`
      : 'Intensitetsadherens: ingen data',
    zoneDist
      ? `Sonedistribusjon: ${zoneDist.slice(0, 4).map(z => `${z.type} ${z.pct}%`).join(', ')}`
      : null,
    painTrend
      ? `Smerte-trend: snitt ${painTrend.avg}/10, siste ${painTrend.latest}/10, trend ${painTrend.trend > 0.5 ? '↑ stigende' : painTrend.trend < -0.5 ? '↓ synkende' : '→ stabil'}`
      : null,
  ].filter(Boolean).join('\n');

  // Recent sessions (last 15)
  const sessionLines = sessions.recent.slice(0, 15).map(s =>
    [
      s.dato,
      s.navn || s.type,
      s.type,
      s.varighet ? s.varighet + 'min' : null,
      s.faktiskSnittHR ? `HR ${s.faktiskSnittHR}/${s.faktiskMaksHR ?? '?'}` : null,
      s.planlagtPuls ? `(mål: ${s.planlagtPuls})` : null,
      s.pace ? `@${s.pace}` : null,
      s.smerte != null ? `smerte: ${s.smerte}/10` : null,
      s.vurdering ? `"${s.vurdering.slice(0, 60)}"` : null,
    ].filter(Boolean).join(' · ')
  ).join('\n');

  // Upcoming plan (next 10)
  const planLines = sessions.upcoming.slice(0, 10).map(s =>
    `[${s.id}] ${s.dato}: ${s.navn} — ${s.type}${s.varighet ? ' ' + s.varighet + 'min' : ''}${s.planlagtPuls ? ' HR:' + s.planlagtPuls : ''}${s.vurdering ? '\n   → ' + s.vurdering.slice(0, 100) : ''}`
  ).join('\n');

  // Goals
  const goalLines = goals
    .map(g => `${g.dato}: ${g.navn}${g.planlagtPuls ? ' (mål: ' + g.planlagtPuls + ')' : ''}`)
    .join('\n');

  // Health (last 5 days)
  const healthLines = health.slice(0, 5).map(h => {
    const parts = [];
    if (h.sovnTimer != null) parts.push(`${h.sovnTimer}t søvn${h.sovnKvalitet ? ' (' + ['', 'dårlig', 'ok', 'bra'][h.sovnKvalitet] + ')' : ''}`);
    if (h.hrv != null) parts.push(`HRV ${h.hrv} ms`);
    if (h.energi != null) parts.push(`energi ${h.energi}/5`);
    if (h.protein != null) parts.push(`protein ${h.protein}/6P`);
    return `${h.dato}: ${parts.join(', ') || '(ingen data)'}`;
  }).join('\n');

  // Journal memory
  const journalBlock = journal.length
    ? journal.map(e =>
        `[${e.ts.split('T')[0]}] ${e.type.toUpperCase()}: ${e.content}`
      ).join('\n\n')
    : '(ingen journal-entringer ennå)';

  return `\
=== DATO ===
${today}

=== UTØVERPROFIL ===
${profileBlock}

=== BEREDSKAP I DAG ===
${readinessBlock}

=== BELASTNINGSMETRIKK ===
${metricsBlock}

=== HELSE (siste 5 dager) ===
${healthLines || '(ingen data)'}

=== SISTE 15 GJENNOMFØRTE ØKTER ===
${sessionLines || '(ingen)'}

=== PLANLAGTE ØKTER (To Do) ===
${planLines || '(ingen planlagte)'}

=== KOMMENDE MÅL / RACE ===
${goalLines || '(ingen)'}

=== TRENER-JOURNAL (hukommelse) ===
${journalBlock}
${extra ? '\n=== TILLEGGSKONTEKST ===\n' + extra : ''}\
`;
}

// ── Claude API call ───────────────────────────────────────────────────────────

async function callClaude(env, userMessage, maxTokens = 1200) {
  return withRetry(async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`Claude ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.content?.find(b => b.type === 'text')?.text || '';
  });
}

// ── Operation 1: Daily readiness ──────────────────────────────────────────────

/**
 * Morning check-in. State already contains readiness signal.
 * Coach explains signal and prescribes today's session modification.
 */
export async function coachReadiness(env, state, journal) {
  const todaySession = state.sessions.today.find(s => s.status === 'To Do');

  const userMsg = buildContext(state, journal, todaySession
    ? `Planlagt økt i dag: ${todaySession.navn} — ${todaySession.type}${todaySession.varighet ? ' ' + todaySession.varighet + 'min' : ''}${todaySession.planlagtPuls ? ', mål HR: ' + todaySession.planlagtPuls : ''}${todaySession.vurdering ? '\nInstruksjoner: ' + todaySession.vurdering : ''}`
    : 'Ingen økt planlagt i dag.'
  ) + `

OPPGAVE — BEREDSKAPSANALYSE:
Basert på signalet (${state.readiness.signal.toUpperCase()}, score ${state.readiness.score}/100), gi en konkret beredskapsanalyse:
1. Hva sier dataene og hvorfor (maks 2 setninger)
2. Hva gjør atleten med dagens økt — konkret og spesifikt (ikke "bare rolig")
3. Hva skal atleten være obs på i dag
4. Ett ernæringstips for i dag

Vær kortfattet. Helheten tar maks 150 ord.`;

  const text = await callClaude(env, userMsg, 600);

  // Journal the prescription so future ops see it
  await appendJournal(env, {
    type: 'readiness',
    content: `${state.today}: ${state.readiness.signal.toUpperCase()} (score ${state.readiness.score}). Foreskrev: ${state.readiness.prescription}. ${text.slice(0, 200)}`,
  });

  return { text, signal: state.readiness.signal, score: state.readiness.score, prescription: state.readiness.prescription };
}

// ── Operation 2: Post-session debrief ─────────────────────────────────────────

/**
 * After a session is logged. Analyzes intensity adherence, pain, and notes.
 * Updates journal and flags if next similar session should be modified.
 */
export async function coachDebrief(env, state, journal, session) {
  const { planlagtPuls, faktiskSnittHR, faktiskMaksHR, varighet, smerte, vurdering, type, navn, dato } = session;

  // Intensity adherence for this specific session
  let adherenceNote = '';
  if (planlagtPuls && faktiskSnittHR) {
    const m = planlagtPuls.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (m) {
      const low = Number(m[1]), high = Number(m[2]);
      const margin = 5;
      if (faktiskSnittHR < low - margin) adherenceNote = `For lett: snitt-HR ${faktiskSnittHR} under mål ${planlagtPuls}`;
      else if (faktiskSnittHR > high + margin) adherenceNote = `For hardt: snitt-HR ${faktiskSnittHR} over mål ${planlagtPuls}`;
      else adherenceNote = `Treff: snitt-HR ${faktiskSnittHR} innenfor mål ${planlagtPuls}`;
    }
  }

  const sessionBlock = [
    `Økt: ${navn || type} (${dato})`,
    `Type: ${type} | Varighet: ${varighet ?? '?'} min`,
    faktiskSnittHR ? `Snitt-HR: ${faktiskSnittHR} | Maks-HR: ${faktiskMaksHR ?? '?'}` : null,
    planlagtPuls   ? `Planlagt puls: ${planlagtPuls}` : null,
    adherenceNote  ? `Intensitetsdom: ${adherenceNote}` : null,
    smerte != null ? `Smerte: ${smerte}/10` : null,
    vurdering      ? `Notater: "${vurdering}"` : null,
  ].filter(Boolean).join('\n');

  const userMsg = buildContext(state, journal, sessionBlock) + `

OPPGAVE — ØKTANALYSE:
Analyser denne gjennomførte økten. Du må:
1. Vurdere intensitetstreffen (traff/for hardt/for lett) og hva det betyr fremover
2. Kommentere på smertescore hvis relevant (> 3 = hard gate)
3. Si konkret hva som justeres i neste tilsvarende økt
4. Oppdater din forståelse av utøverens status

Svar med dette JSON-formatet og INGEN annen tekst:
{"analyse":"din analyse (3-5 setninger)","justerNeste":false,"justering":"null eller konkret endring til neste tilsvarende økt","journalEntry":"1-2 setninger til trener-journalen om hva du observerte i dag"}`;

  const raw = await callClaude(env, userMsg, 800);

  let result;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    result = match ? JSON.parse(match[0]) : { analyse: raw, justerNeste: false, justering: null, journalEntry: raw.slice(0, 150) };
  } catch {
    result = { analyse: raw, justerNeste: false, justering: null, journalEntry: raw.slice(0, 150) };
  }

  if (result.journalEntry) {
    await appendJournal(env, {
      type: 'debrief',
      content: `${dato} ${navn||type}: ${result.journalEntry}${result.justerNeste && result.justering ? ' | JUSTER: ' + result.justering : ''}`,
    });
  }

  return result;
}

// ── Operation 3: Plan ─────────────────────────────────────────────────────────

/**
 * Plan or re-plan sessions. Triggered by:
 * - User asks for a plan in chat
 * - ACWR drifts out of range (caller's responsibility to detect and trigger)
 * - Significant pain pattern detected
 *
 * Returns structured plan + coach summary.
 */
export async function coachPlan(env, state, journal, userRequest = '') {
  const userMsg = buildContext(state, journal) + `

OPPGAVE — PLANLEGGING:
${userRequest || 'Lag en treningsplan for neste 1-2 uker som passer belastningsstatus og mål.'}

Du har tilgang til eksisterende planlagte økter (se over). Du kan:
- Endre en eksisterende økt: bruk action "update" med notionId fra listen
- Legge til ny økt: action "create"
- Fjerne en økt: action "delete"

Svar med dette formatet (JSON-blokk + forklaring under):
\`\`\`json
{"sessions":[
  {"action":"create","dato":"YYYY-MM-DD","navn":"Navn","type":"Sone 2","varighet":45,"planlagtPuls":"130-145","beskrivelse":"Instruksjon"},
  {"action":"update","notionId":"eksisterende-id","dato":"YYYY-MM-DD","navn":"Ny tittel","type":"Terskel","varighet":50,"planlagtPuls":"155-168"},
  {"action":"delete","notionId":"eksisterende-id","navn":"Økt som fjernes"}
],"summary":"Begrunnelse"}
\`\`\`

Gyldige type-verdier: Sone 2, Terskel, Bakkeintervall, Styrke, Rehab, Race, Testløp, Dagbok.
Deretter: forklar planen i 3-5 setninger. Hva er prioriteringen og hvorfor?`;

  const text = await callClaude(env, userMsg, 2000);

  // Parse JSON block if present
  let sessions = null;
  let summary = '';
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      sessions = parsed.sessions || null;
      summary  = parsed.summary || '';
    } catch { /* non-fatal */ }
  }

  // Everything outside the JSON block is the coach explanation
  const explanation = text.replace(/```json[\s\S]*?```/g, '').trim();

  if (explanation) {
    await appendJournal(env, {
      type: 'plan',
      content: `Plan laget: ${summary || explanation.slice(0, 150)}`,
    });
  }

  return { text: explanation, sessions, summary };
}

// ── Operation 4: Free chat ────────────────────────────────────────────────────

/**
 * Free-form coach chat. Full state + journal always included.
 * History is passed in from the client (last N turns only — client owns the scroll).
 */
export async function coachChat(env, state, journal, message, history = []) {
  const historyBlock = history.length
    ? '\n=== SAMTALEHISTORIKK ===\n' +
      history.slice(-6).map(m => `${m.role === 'user' ? 'Arnar' : 'Trener'}: ${m.content}`).join('\n\n')
    : '';

  const userMsg = buildContext(state, journal) + historyBlock + `

Arnar: ${message}
Trener:`;

  const text = await callClaude(env, userMsg, 1500);

  // If response contains a plan JSON block, extract it
  let sessions = null;
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.sessions) sessions = parsed.sessions;
    } catch { /* non-fatal */ }
  }

  // Opportunistically journal significant moments from chat
  if (text.length > 100 && (message.toLowerCase().includes('plan') || message.toLowerCase().includes('anbefal') || sessions)) {
    await appendJournal(env, {
      type: 'chat',
      content: `Chat: "${message.slice(0, 80)}" → ${text.slice(0, 120)}`,
    });
  }

  return { text, sessions };
}
