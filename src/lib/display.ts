/**
 * display.ts — User-facing label helpers.
 *
 * BD stores enums and categories as snake_case lowercase slugs ("cruz_roja",
 * "infraestructura_bache"). Tools should pass these through prettify* helpers
 * before exposing to the LLM, so the assistant never echoes raw slugs to the
 * end user.
 */

/**
 * Generic prettifier: snake_case lowercase → "Title case with spaces".
 * "punto_violeta" → "Punto violeta".
 * "cruz_roja"     → "Cruz roja".  (no diacritics added — use specific maps below if needed)
 */
export function prettifySlug(s: string | null | undefined): string | null {
  if (!s) return s ?? null;
  const spaced = s.replace(/_/g, " ").trim();
  if (spaced.length === 0) return spaced;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Specific labels for emergency_contacts.category — manually curated to add
 * proper accents and capitalisation that prettifySlug cannot infer.
 */
const EMERGENCY_CATEGORY_LABELS: Record<string, string> = {
  bomberos: "Bomberos",
  cruz_roja: "Cruz Roja",
  denuncia_anonima: "Denuncia anónima",
  emergencia_general: "Emergencia general",
  fiscalia: "Fiscalía",
  locatel: "LOCATEL",
  mujer: "Atención a la mujer",
  policia: "Policía",
  proteccion_civil: "Protección Civil",
};

export function prettifyEmergencyCategory(s: string | null | undefined): string | null {
  if (!s) return s ?? null;
  return EMERGENCY_CATEGORY_LABELS[s] ?? prettifySlug(s);
}

/**
 * Specific labels for report category / type slugs from report_taxonomy.
 * The LLM can infer most of these but we provide a deterministic mapping for
 * the high-frequency ones to avoid drift between turns.
 */
const REPORT_CATEGORY_LABELS: Record<string, string> = {
  infraestructura: "Infraestructura",
  alumbrado: "Alumbrado público",
  arbolado: "Arbolado",
  limpia: "Limpieza",
  animales: "Animales",
  transporte: "Transporte",
  emergencias: "Emergencia",
  otro: "Otro",
};

const REPORT_TYPE_LABELS: Record<string, string> = {
  infraestructura_bache: "Bache",
  infraestructura_socavon: "Socavón",
  infraestructura_fuga_agua: "Fuga de agua",
  infraestructura_banqueta: "Banqueta dañada",
  infraestructura_balizamiento: "Balizamiento",
  alumbrado_luminaria: "Luminaria",
  arbolado_derribo: "Árbol caído",
  limpia_recoleccion: "Recolección de basura",
  limpia_tiradero: "Tiradero clandestino",
  limpia_animal_muerto: "Animal muerto en vía pública",
  animales_maltrato: "Maltrato animal",
  animales_herido: "Animal herido",
  animales_extraviado: "Animal extraviado",
  otro_general: "Otro",
};

export function prettifyReportCategory(slug: string | null | undefined): string | null {
  if (!slug) return slug ?? null;
  return REPORT_CATEGORY_LABELS[slug] ?? prettifySlug(slug);
}

export function prettifyReportType(slug: string | null | undefined): string | null {
  if (!slug) return slug ?? null;
  return REPORT_TYPE_LABELS[slug] ?? prettifySlug(slug);
}

/**
 * Match phase labels for v_mundial_partidos.fase — the LLM usually formats
 * these well, but the helper exists for tools that want to surface a clean
 * label preformatted.
 */
const MUNDIAL_FASE_LABELS: Record<string, string> = {
  grupos: "Fase de grupos",
  dieciseisavos: "Dieciseisavos de final",
  octavos: "Octavos de final",
  cuartos: "Cuartos de final",
  semifinal: "Semifinal",
  tercer_lugar: "Tercer lugar",
  final: "Final",
};

export function prettifyMundialFase(slug: string | null | undefined): string | null {
  if (!slug) return slug ?? null;
  return MUNDIAL_FASE_LABELS[slug] ?? prettifySlug(slug);
}

/**
 * Lead status labels (public.leads.status enum).
 */
const LEAD_STATUS_LABELS: Record<string, string> = {
  open: "Abierto",
  pending_review: "En revisión",
  in_progress: "En proceso",
  in_review: "En revisión",
  resolved: "Resuelto",
  closed: "Cerrado",
  cancelled: "Cancelado",
  rejected: "Rechazado",
};

export function prettifyLeadStatus(s: string | null | undefined): string | null {
  if (!s) return s ?? null;
  return LEAD_STATUS_LABELS[s] ?? prettifySlug(s);
}
