/**
 * Safety protocol responses for gender-based violence emergencies.
 *
 * genderEmergencyResponse() is called directly when the pre-LLM guardrail
 * fires, bypassing the main LLM pipeline entirely.
 * NEVER invent data — only what is present in the `canalizacion` argument.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Canalizacion {
  /** Puntos Violeta with 24/7 service */
  puntos_violeta_24_7: Array<{
    nombre: string;
    direccion: string;
    telefono?: string;
  }>;
  /** General emergency contacts */
  contactos: Array<{ nombre: string; descripcion?: string }>;
  /** Key phone numbers: e.g. { "911": "Emergencias", "LUNAS": "800 290 0024" } */
  telefonos_clave: Record<string, string>;
}

type SupportedLang = "es" | "en" | "it" | "fr" | "pt";

// ---------------------------------------------------------------------------
// Per-language templates
// ---------------------------------------------------------------------------

interface LangTemplate {
  empathy: string;
  immediate: string;
  points_header: string;
  phones_header: string;
  contacts_header: string;
  phone_label: string;
  no_points: string;
}

const TEMPLATES: Record<SupportedLang, LangTemplate> = {
  es: {
    empathy: "Estoy aquí contigo. Tu seguridad es lo primero.",
    immediate: "Si estás en peligro inmediato, llama al 911.",
    points_header: "Puntos Violeta 24/7 más cercanos:",
    phones_header: "Números clave:",
    contacts_header: "Más apoyo:",
    phone_label: "Tel.",
    no_points: "Consulta a las autoridades locales para el punto más cercano.",
  },
  en: {
    empathy: "I am here with you. Your safety comes first.",
    immediate: "If you are in immediate danger, call 911.",
    points_header: "Nearest 24/7 Puntos Violeta (safe spaces):",
    phones_header: "Key numbers:",
    contacts_header: "Additional support:",
    phone_label: "Tel.",
    no_points: "Contact local authorities for the nearest safe space.",
  },
  it: {
    empathy: "Sono qui con te. La tua sicurezza viene prima di tutto.",
    immediate: "Se sei in pericolo immediato, chiama il 911.",
    points_header: "Puntos Violeta 24/7 più vicini:",
    phones_header: "Numeri chiave:",
    contacts_header: "Altro supporto:",
    phone_label: "Tel.",
    no_points: "Contatta le autorità locali per lo spazio sicuro più vicino.",
  },
  fr: {
    empathy: "Je suis là avec toi. Ta sécurité est la priorité.",
    immediate: "Si tu es en danger immédiat, appelle le 911.",
    points_header: "Points Violeta 24h/7j les plus proches :",
    phones_header: "Numéros clés :",
    contacts_header: "Soutien supplémentaire :",
    phone_label: "Tél.",
    no_points:
      "Contacte les autorités locales pour trouver l'espace sûr le plus proche.",
  },
  pt: {
    empathy: "Estou aqui com você. Sua segurança vem em primeiro lugar.",
    immediate: "Se você estiver em perigo imediato, ligue para o 911.",
    points_header: "Pontos Violeta 24/7 mais próximos:",
    phones_header: "Números importantes:",
    contacts_header: "Mais apoio:",
    phone_label: "Tel.",
    no_points:
      "Entre em contato com as autoridades locais para encontrar o espaço seguro mais próximo.",
  },
};

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

/**
 * Builds a ready-to-send emergency response string using only the data
 * present in `canalizacion`. Never invents phone numbers, addresses, or names.
 *
 * Structure:
 *   1. Empathy line
 *   2. Immediate action (911)
 *   3. 24/7 Puntos Violeta list
 *   4. Key phone numbers
 *   5. Additional contacts
 *
 * @param canalizacion  Emergency data obtained from a trusted tool call.
 * @param lang          User's language (default: 'es').
 */
export function genderEmergencyResponse(
  canalizacion: Canalizacion,
  lang: SupportedLang = "es",
): string {
  const t = TEMPLATES[lang];
  const lines: string[] = [];

  // 1. Empathy + immediate action
  lines.push(t.empathy);
  lines.push(t.immediate);
  lines.push("");

  // 2. 24/7 Puntos Violeta
  if (canalizacion.puntos_violeta_24_7.length > 0) {
    lines.push(t.points_header);
    for (const pv of canalizacion.puntos_violeta_24_7) {
      const phone =
        pv.telefono != null && pv.telefono.trim().length > 0
          ? ` — ${t.phone_label} ${pv.telefono}`
          : "";
      lines.push(`• ${pv.nombre}, ${pv.direccion}${phone}`);
    }
  } else {
    lines.push(t.no_points);
  }
  lines.push("");

  // 3. Key phone numbers
  const phoneEntries = Object.entries(canalizacion.telefonos_clave);
  if (phoneEntries.length > 0) {
    lines.push(t.phones_header);
    for (const [number, description] of phoneEntries) {
      lines.push(`• ${description}: ${number}`);
    }
    lines.push("");
  }

  // 4. Additional contacts
  if (canalizacion.contactos.length > 0) {
    lines.push(t.contacts_header);
    for (const c of canalizacion.contactos) {
      const desc = c.descripcion != null ? ` — ${c.descripcion}` : "";
      lines.push(`• ${c.nombre}${desc}`);
    }
  }

  return lines.join("\n").trim();
}
