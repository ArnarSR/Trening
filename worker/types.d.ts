// TypeScript types for the /api/analyse endpoint

/** One HR zone and time spent in it */
export interface HRSone {
  zone: 1 | 2 | 3 | 4 | 5;
  minutter: number;
}

/** A completed or planned training session */
export interface OktInput {
  /** Display name, e.g. "Rolig S2-løp" */
  navn?: string;
  /** Training type, e.g. "Sone 2", "Terskel", "Bakkeintervall" */
  type: string;
  /** Sport emoji + label, e.g. "🏃 Løp", "🚴 Sykkel" */
  sport?: string;
  /** Actual duration in minutes */
  varighet: number;
  /** Average HR in bpm */
  faktiskSnittHR?: number;
  /** Max HR in bpm */
  faktiskMaksHR?: number;
  /** Pace string, e.g. "5:23" (min:sec per km) */
  pace?: string;
  /** Distance in km */
  distanse?: number;
  /** Pain level 0–10 (hofte/kne) */
  smerte?: number;
  /** ISO date string, e.g. "2026-05-23" */
  dato?: string;
  /** Free-text notes */
  vurdering?: string;
  /** Time spent per HR zone */
  hrSoner?: HRSone[];
}

/** Sleep data for the previous night */
export interface SovnInput {
  /** Total sleep in hours */
  total?: number;
  /** Deep sleep in hours */
  dyp?: number;
  /** REM sleep in hours */
  rem?: number;
  /** Light sleep in hours */
  lett?: number;
  /** Device sleep score 0–100 */
  score?: number;
  /** Subjective quality: 1=Dårlig, 2=OK, 3=Bra */
  kvalitet?: 1 | 2 | 3;
}

/** Heart Rate Variability reading */
export interface HRVInput {
  /** HRV value in ms (RMSSD or SDNN depending on device) */
  verdi?: number;
  /** Status label from device, e.g. "Balansert", "Lavt", "Høyt" */
  status?: string;
  /** Free-text feedback from device, e.g. "Kroppen er klar for normal belastning" */
  feedback?: string;
}

/** A summary of one previous session (for historical context) */
export interface HistorikkEntry {
  dato: string;
  type: string;
  sport?: string;
  varighet?: number;
  faktiskSnittHR?: number;
  distanse?: number;
  smerte?: number;
}

// ── Request bodies ────────────────────────────────────────────────────────────

/** Structured session analysis — returns AnalyseOutput */
export interface StructuredAnalyseRequest {
  okt: OktInput;
  sovn?: SovnInput;
  hrv?: HRVInput;
  /** Up to 7 recent sessions for load context */
  historikk?: HistorikkEntry[];
}

/** Legacy free-form mode — returns { text: string } */
export interface LegacyAnalyseRequest {
  prompt: string;
}

export type AnalyseRequest = StructuredAnalyseRequest | LegacyAnalyseRequest;

// ── Response bodies ───────────────────────────────────────────────────────────

/** Structured response from POST /api/analyse with session data */
export interface AnalyseOutput {
  /** 2–3 sentence summary of the completed session */
  summary: string;
  /** Load assessment: "Lett" | "Moderat" | "Høy" | "For høy" */
  loadAssessment: string;
  /** Recovery status based on sleep, HRV and pain */
  recoveryStatus: string;
  /** Concrete recommendation for the next session */
  nextSessionRecommendation: string;
  /** One motivating sentence */
  motivation: string;
}

/** Legacy response from POST /api/analyse with a prompt */
export interface LegacyAnalyseOutput {
  text: string;
}

/** Error response */
export interface ErrorOutput {
  error: string;
  fields?: Record<string, string>;
}
