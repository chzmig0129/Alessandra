/**
 * Welcome block for first-time users. Not wired into the web /chat flow;
 * intended for the upcoming WhatsApp integration where the upstream
 * resolver will expose an __is_new_user flag.
 *
 * The legal notice (first paragraph) must keep its full weight in every
 * language — do not soften it. Proper names ("Alcaldía Cuauhtémoc",
 * "Alessandra") stay in Spanish in all variants.
 */

export type WelcomeLang = "es" | "en" | "pt" | "fr" | "it";

const BLOCKS: Record<WelcomeLang, string> = {
  es: `Este servicio es de carácter exclusivamente informativo, ajeno a fines políticos o electorales. Limitado a la difusión de programas, gestiones, servicios y oferta turística de la Alcaldía Cuauhtémoc. El uso distinto será causa de suspensión inmediata.

Hola, ¡qué gusto saludarte! Soy Alessandra, asistente de la Alcaldía Cuauhtémoc. Me entrego en cuerpo y alma para servir a la comunidad. ¿Cómo puedo ayudarte hoy, vecina o vecino?`,
  en: `This service is strictly informational and unrelated to political or electoral purposes. It is limited to disseminating programs, actions, services, and tourism offerings of the Alcaldía Cuauhtémoc. Any other use will result in immediate suspension.

Hello, it is a pleasure to greet you! I am Alessandra, assistant of the Alcaldía Cuauhtémoc. I am fully dedicated to serving the community. How can I help you today, neighbor?`,
  pt: `Este serviço tem caráter exclusivamente informativo, alheio a fins políticos ou eleitorais. Limitado à divulgação de programas, ações, serviços e oferta turística da Alcaldía Cuauhtémoc. O uso distinto será causa de suspensão imediata.

Olá, que prazer em cumprimentá-lo(a)! Sou Alessandra, assistente da Alcaldía Cuauhtémoc. Dedico-me de corpo e alma a servir a comunidade. Como posso ajudá-lo(a) hoje, vizinho(a)?`,
  fr: `Ce service est à caractère exclusivement informatif, étranger à toute fin politique ou électorale. Il est limité à la diffusion des programmes, actions, services et offre touristique de la Alcaldía Cuauhtémoc. Tout autre usage entraînera une suspension immédiate.

Bonjour, c’est un plaisir de vous saluer ! Je suis Alessandra, assistante de la Alcaldía Cuauhtémoc. Je me consacre corps et âme à servir la communauté. Comment puis-je vous aider aujourd’hui, chère voisine ou cher voisin ?`,
  it: `Questo servizio ha carattere esclusivamente informativo, estraneo a fini politici o elettorali. È limitato alla diffusione di programmi, azioni, servizi e offerta turistica dell’Alcaldía Cuauhtémoc. Ogni altro uso sarà causa di sospensione immediata.

Ciao, che piacere salutarti! Sono Alessandra, assistente dell’Alcaldía Cuauhtémoc. Mi dedico anima e corpo a servire la comunità. Come posso aiutarti oggi, caro vicino o cara vicina?`,
};

/**
 * Returns the welcome block for a supported language. Defaults to Spanish.
 */
export function welcomeBlock(lang: WelcomeLang = "es"): string {
  return BLOCKS[lang];
}
