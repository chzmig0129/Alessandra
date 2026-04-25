/**
 * elevenlabs-tool-schemas.ts
 *
 * JSON Schema definitions for all 17 voice-allowed tools.
 * Used by scripts/elevenlabs-deploy-agent.ts to register server tools
 * on the ElevenLabs Agents API.
 *
 * Each entry:
 *   name        — must match VOICE_TOOL_ALLOWLIST exactly
 *   description — shown to the LLM as tool docs (Spanish, concise)
 *   parameters_schema — JSON Schema for the `args` object the agent sends
 *
 * Fully specified (8 core tools):
 *   knowledge_buscar, mundial_partidos_buscar, puntos_violeta_buscar,
 *   reporte_iniciar, reporte_slot_llenar, reporte_confirmar_y_crear,
 *   reporte_consultar, consulta_analitica_sql, mundial_sede_info,
 *   mundial_como_llegar
 *
 * Stub schemas (remaining 7) — marked TODO: tighten schema
 */

export interface VoiceToolSchema {
  name: string;
  description: string;
  parameters_schema: Record<string, unknown>;
}

export const VOICE_TOOL_SCHEMAS: VoiceToolSchema[] = [
  // ---------------------------------------------------------------------------
  // 1. knowledge_buscar — búsqueda semántica en base de conocimiento
  // ---------------------------------------------------------------------------
  {
    name: "knowledge_buscar",
    description:
      "Busca información general de la Alcaldía Cuauhtémoc (museos, trámites, salud, cultura, gastronomía, deportes) " +
      "usando búsqueda semántica con embeddings. Úsala antes de decir 'no tengo información'.",
    parameters_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 3,
          description:
            "Pregunta o frase del usuario para buscar en la base de conocimiento. Ej: 'museos en la alcaldía', 'requisitos licencia de construcción'.",
        },
        category: {
          type: "string",
          enum: [
            "tramites",
            "puntos_violeta",
            "info_general",
            "salud",
            "deportes",
            "estadios",
            "gastronomia",
            "cultura",
            "servicios_urbanos",
            "eventos",
          ],
          description: "Opcional. Filtra por categoría temática.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Número máximo de resultados (default 5, máx 10).",
        },
      },
      required: ["query"],
    },
  },

  // ---------------------------------------------------------------------------
  // 2. mundial_partidos_buscar — búsqueda flexible de partidos FIFA 2026
  // ---------------------------------------------------------------------------
  {
    name: "mundial_partidos_buscar",
    description:
      "Busca partidos del Mundial FIFA 2026. Filtra por equipo (código FIFA 3 letras), fecha, ciudad, país, fase o grupo. " +
      "NO combines fecha+equipo a menos que el usuario pida un día específico.",
    parameters_schema: {
      type: "object",
      properties: {
        fecha: {
          type: "string",
          description: "Fecha en formato YYYY-MM-DD. Ej: '2026-06-11'. No combinar con equipo salvo petición explícita.",
        },
        equipo: {
          type: "string",
          description: "Código FIFA 3 letras en MAYÚSCULAS. Ej: MEX, USA, ARG, BRA, ESP.",
        },
        ciudad: {
          type: "string",
          description: "Ciudad sede. Ej: 'Ciudad de México', 'Zapopan', 'Arlington', 'Toronto'.",
        },
        pais: {
          type: "string",
          description: "País: 'México', 'Estados Unidos' o 'Canadá'.",
        },
        fase: {
          type: "string",
          enum: ["grupos", "dieciseisavos", "octavos", "cuartos", "semifinal", "tercer_lugar", "final"],
          description: "Fase del torneo.",
        },
        grupo: {
          type: "string",
          description: "Letra del grupo A-L. Solo aplica en fase de grupos.",
        },
        estado: {
          type: "string",
          enum: ["programado", "en_vivo", "finalizado", "suspendido"],
          description: "Estado del partido.",
        },
        proximos: {
          type: "boolean",
          description: "Si true, solo partidos desde ahora en adelante.",
        },
        order_by: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Orden por fecha. Default 'asc'.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Número máximo de partidos (default 10, max 50).",
        },
      },
      required: [],
    },
  },

  // ---------------------------------------------------------------------------
  // 3. puntos_violeta_buscar — búsqueda de Puntos Violeta
  // ---------------------------------------------------------------------------
  {
    name: "puntos_violeta_buscar",
    description:
      "Busca Puntos Violeta de la Alcaldía Cuauhtémoc. SIEMPRE invocar cuando el usuario mencione " +
      "'punto violeta', 'ayuda mujer', 'emergencia género' o equivalente. Acepta filtros opcionales (lat/lng, colonia, abierto_ahora).",
    parameters_schema: {
      type: "object",
      properties: {
        lat: {
          type: "number",
          minimum: -90,
          maximum: 90,
          description: "Latitud decimal del usuario para ordenar por distancia. Ej: 19.4326.",
        },
        lng: {
          type: "number",
          minimum: -180,
          maximum: 180,
          description: "Longitud decimal del usuario para ordenar por distancia. Ej: -99.1332.",
        },
        radio_km: {
          type: "number",
          description: "Radio de búsqueda en kilómetros (requiere lat/lng). Default: 5 km.",
        },
        colonia: {
          type: "string",
          description: "Colonia específica. Ej: 'Roma Norte', 'Doctores', 'Centro'.",
        },
        tipo_atencion: {
          type: "string",
          description: "Tipo de atención. Ej: 'jurídica', 'psicológica', 'refugio'.",
        },
        abierto_ahora: {
          type: "boolean",
          description: "Si true, solo puntos con atención 24/7.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Número máximo de resultados (default 10, max 50).",
        },
      },
      required: [],
    },
  },

  // ---------------------------------------------------------------------------
  // 4. reporte_iniciar — inicia un nuevo flujo de reporte ciudadano
  // ---------------------------------------------------------------------------
  {
    name: "reporte_iniciar",
    description:
      "Inicia el flujo de un nuevo reporte ciudadano. Invocar en cuanto el usuario exprese intención de reportar " +
      "('quiero reportar', 'hay un bache', 'reportar fuga', 'se cayó un árbol'). " +
      "Después de esta tool, llenar slots con reporte_slot_llenar en orden: categoria → tipo → descripcion → ubicacion → fotos.",
    parameters_schema: {
      type: "object",
      properties: {
        conversation_id: {
          type: "string",
          minLength: 1,
          description: "ID de la conversación activa (UUID).",
        },
        intencion: {
          type: "string",
          minLength: 1,
          description: "Frase corta del intent del usuario. Ej: 'reportar bache', 'hay fuga de agua'.",
        },
        lat: {
          type: "number",
          description: "Latitud del usuario si está disponible — pre-llena el slot ubicacion.",
        },
        lng: {
          type: "number",
          description: "Longitud del usuario si está disponible — pre-llena el slot ubicacion.",
        },
        categoria_hint: {
          type: "string",
          description: "Hint inicial de categoría inferido del texto. Ej: 'bache', 'foco', 'basura'.",
        },
      },
      required: ["conversation_id", "intencion"],
    },
  },

  // ---------------------------------------------------------------------------
  // 5. reporte_slot_llenar — llena un slot del flujo activo
  // ---------------------------------------------------------------------------
  {
    name: "reporte_slot_llenar",
    description:
      "Llena un slot del flujo activo de reporte ciudadano. " +
      "Orden obligatorio: categoria → tipo → descripcion → ubicacion → fotos. " +
      "Para el slot 'fotos' en voz, pasa siempre el literal 'sin_foto' ya que el canal voz no acepta imágenes.",
    parameters_schema: {
      type: "object",
      properties: {
        conversation_id: {
          type: "string",
          minLength: 1,
          description: "ID de la conversación activa.",
        },
        slot: {
          type: "string",
          enum: ["categoria", "tipo", "descripcion", "ubicacion", "fotos", "confirmado"],
          description: "Clave del slot a llenar.",
        },
        valor: {
          type: "string",
          description:
            "Valor del slot como string. " +
            "Para ubicacion: JSON stringify de {lat, lng} o {direccion_libre, colonia}. " +
            "Para fotos en voz: el literal '\"sin_foto\"'. " +
            "Para confirmado: 'true'. Para categoria/tipo/descripcion: string plano.",
        },
      },
      required: ["conversation_id", "slot", "valor"],
    },
  },

  // ---------------------------------------------------------------------------
  // 6. reporte_confirmar_y_crear — crea el reporte en BD
  // ---------------------------------------------------------------------------
  {
    name: "reporte_confirmar_y_crear",
    description:
      "Crea el reporte ciudadano en la base de datos. " +
      "Invocar cuando el usuario diga 'sí' o 'confirmo' después del resumen. " +
      "Devuelve folio (CUH-YYYYMMDD-NNN). Los slots categoria, tipo, descripcion y ubicacion deben estar llenos.",
    parameters_schema: {
      type: "object",
      properties: {
        conversation_id: {
          type: "string",
          minLength: 1,
          description: "ID de la conversación activa.",
        },
        user_id: {
          type: "string",
          minLength: 1,
          description: "ID del usuario en la tabla public.users.",
        },
      },
      required: ["conversation_id", "user_id"],
    },
  },

  // ---------------------------------------------------------------------------
  // 7. reporte_consultar — consulta un reporte por folio o el más reciente
  // ---------------------------------------------------------------------------
  {
    name: "reporte_consultar",
    description:
      "Consulta un reporte por folio o, si el folio se omite, el más reciente del usuario. " +
      "Requiere user_id para privacidad.",
    parameters_schema: {
      type: "object",
      properties: {
        conversation_id: {
          type: "string",
          minLength: 1,
          description: "ID de la conversación activa.",
        },
        user_id: {
          type: "string",
          minLength: 1,
          description: "ID del usuario.",
        },
        folio: {
          type: "string",
          description: "Folio del reporte. Ej: 'CUH-20260101-001'. Opcional — si se omite, devuelve el más reciente.",
        },
      },
      required: ["conversation_id", "user_id"],
    },
  },

  // ---------------------------------------------------------------------------
  // 8. consulta_analitica_sql — SQL de último recurso contra vistas de solo lectura
  // ---------------------------------------------------------------------------
  {
    name: "consulta_analitica_sql",
    description:
      "Ejecuta una consulta SELECT de solo lectura contra las vistas analíticas (v_mundial_partidos, v_mundial_sedes, " +
      "v_puntos_violeta, v_tramites, etc.). Usar como fallback cuando las tools especializadas no devuelven resultados.",
    parameters_schema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description:
            "Consulta SELECT válida contra vistas v_*. " +
            "LIMIT obligatorio (máx 50). Solo SELECT/WITH. " +
            "Usar ILIKE para búsquedas de texto. String literals con comillas simples.",
        },
        razon: {
          type: "string",
          description: "Breve justificación de por qué se usa SQL directo.",
        },
      },
      required: ["sql"],
    },
  },

  // ---------------------------------------------------------------------------
  // 9. mundial_sede_info — información de un estadio sede
  // ---------------------------------------------------------------------------
  {
    name: "mundial_sede_info",
    description:
      "Devuelve información completa de un estadio sede del Mundial 2026: nombre, ciudad, dirección, capacidad, zona horaria, Google Maps.",
    parameters_schema: {
      type: "object",
      properties: {
        id_or_city: {
          type: "string",
          description:
            "Identificador de la sede: ID numérico (ej: '8'), nombre del estadio (ej: 'Estadio Azteca'), o ciudad (ej: 'Ciudad de México').",
        },
      },
      required: ["id_or_city"],
    },
  },

  // ---------------------------------------------------------------------------
  // 10. mundial_como_llegar — ruta desde usuario hasta sede o Fan Fest
  // ---------------------------------------------------------------------------
  {
    name: "mundial_como_llegar",
    description:
      "Calcula la ruta en Google Maps desde la ubicación del usuario hasta una sede del Mundial (estadio) o Fan Fest. " +
      "Requiere lat/lng del usuario.",
    parameters_schema: {
      type: "object",
      properties: {
        tipo: {
          type: "string",
          enum: ["sede", "fan_fest"],
          description: "Tipo de destino: 'sede' para estadios, 'fan_fest' para Fan Festivals.",
        },
        destino_id: {
          type: "integer",
          description: "ID numérico del destino (de v_mundial_sedes o v_mundial_fan_fest).",
        },
        lat: {
          type: "number",
          description: "Latitud del usuario (WGS84).",
        },
        lng: {
          type: "number",
          description: "Longitud del usuario (WGS84).",
        },
      },
      required: ["tipo", "destino_id", "lat", "lng"],
    },
  },

  // ---------------------------------------------------------------------------
  // 11. mundial_fan_fest — Fan Festivals oficiales FIFA 2026
  // ---------------------------------------------------------------------------
  {
    name: "mundial_fan_fest",
    // TODO: tighten schema
    description:
      "Busca los Fan Festivals oficiales de la FIFA 2026. Filtra por ciudad o país.",
    parameters_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ---------------------------------------------------------------------------
  // 12. mundial_partido_detalle — detalles de un partido (eventos, alineaciones)
  // ---------------------------------------------------------------------------
  {
    name: "mundial_partido_detalle",
    // TODO: tighten schema
    description:
      "Devuelve información completa de un partido específico por ID: equipos, marcador, eventos (goles, tarjetas) y alineaciones.",
    parameters_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ---------------------------------------------------------------------------
  // 13. mundial_equipo_info — información de un equipo
  // ---------------------------------------------------------------------------
  {
    name: "mundial_equipo_info",
    // TODO: tighten schema
    description:
      "Devuelve información de un equipo del Mundial 2026: nombre, grupo, ranking FIFA, confederación, próximos partidos.",
    parameters_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ---------------------------------------------------------------------------
  // 14. puntos_violeta_detalle — detalle completo de un Punto Violeta
  // ---------------------------------------------------------------------------
  {
    name: "puntos_violeta_detalle",
    // TODO: tighten schema
    description:
      "Devuelve la información completa de un Punto Violeta específico dado su ID numérico.",
    parameters_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ---------------------------------------------------------------------------
  // 15. emergencia_mujer_canalizar — protocolo emergencia violencia de género
  // ---------------------------------------------------------------------------
  {
    name: "emergencia_mujer_canalizar",
    // TODO: tighten schema
    description:
      "Activa el protocolo de emergencia para situaciones de violencia de género. " +
      "Devuelve Puntos Violeta 24/7 más cercanos, contactos de emergencia y teléfonos clave (*765 LUNAS, 911, LOCATEL).",
    parameters_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ---------------------------------------------------------------------------
  // 16. reporte_cancelar — cancela el flujo de reporte activo
  // ---------------------------------------------------------------------------
  {
    name: "reporte_cancelar",
    // TODO: tighten schema
    description:
      "Cancela el flujo de reporte activo y libera el estado de la conversación. " +
      "Usar cuando el usuario diga 'olvídalo', 'cancela', 'ya no quiero reportar'.",
    parameters_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ---------------------------------------------------------------------------
  // 17. reporte_listar_mios — lista los reportes recientes del usuario
  // ---------------------------------------------------------------------------
  {
    name: "reporte_listar_mios",
    // TODO: tighten schema
    description:
      "Lista los reportes más recientes del usuario. Usar cuando pregunte '¿qué reportes tengo?', 'mis reportes'.",
    parameters_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];
