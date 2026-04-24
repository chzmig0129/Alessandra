/**
 * formatters.ts — Pure formatting functions for Mundial FIFA 2026 domain rows.
 *
 * All dates are converted to America/Mexico_City timezone using
 * Intl.DateTimeFormat. No side effects; no imports from other domains.
 *
 * NEVER infer team names: if equipo_a_codigo is null, use equipo_a_desc
 * literally (e.g. "Ganador partido 73").
 */

import type {
  PartidoRow,
  SedeRow,
  FanFestRow,
  EquipoRow,
  EventoRow,
  AlineacionRow,
} from "./queries";

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const DATE_TIME_FMT = new Intl.DateTimeFormat("es-MX", {
  timeZone: "America/Mexico_City",
  dateStyle: "medium",
  timeStyle: "short",
});

const DATE_FMT = new Intl.DateTimeFormat("es-MX", {
  timeZone: "America/Mexico_City",
  dateStyle: "medium",
});

export function formatFechaCdmx(isoOrNull: string | null | undefined): string {
  if (!isoOrNull) return "Fecha por confirmar";
  const d = new Date(isoOrNull);
  if (Number.isNaN(d.getTime())) return isoOrNull;
  return DATE_TIME_FMT.format(d);
}

export function formatDateOnly(isoOrNull: string | null | undefined): string {
  if (!isoOrNull) return "Fecha por confirmar";
  const d = new Date(isoOrNull + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return isoOrNull;
  return DATE_FMT.format(d);
}

// ---------------------------------------------------------------------------
// Team label helper — NEVER infer: code wins, else use desc literally
// ---------------------------------------------------------------------------

function teamLabel(
  codigo: string | null,
  nombre: string | null,
  desc: string | null,
  emoji?: string | null,
): string {
  if (codigo && nombre) {
    return emoji ? `${emoji} ${nombre}` : nombre;
  }
  // No confirmed team yet — use the literal descriptor
  return desc ?? "Por confirmar";
}

// ---------------------------------------------------------------------------
// partidoToReadable — compact one-liner for LLM context
// ---------------------------------------------------------------------------

export function partidoToReadable(row: PartidoRow): string {
  const teamA = teamLabel(row.equipo_a_codigo, row.equipo_a_nombre, row.equipo_a_desc, row.bandera_a);
  const teamB = teamLabel(row.equipo_b_codigo, row.equipo_b_nombre, row.equipo_b_desc, row.bandera_b);
  const fecha = formatFechaCdmx(row.fecha_hora_cdmx);
  const sede = row.sede_estadio
    ? `${row.sede_estadio}, ${row.sede_ciudad ?? ""}`
    : row.sede_ciudad ?? "Sede por confirmar";

  const fasePart = row.grupo
    ? `Grupo ${row.grupo}`
    : row.fase
      ? capitalize(row.fase.replace(/_/g, " "))
      : null;

  const parts = [
    `${teamA} vs ${teamB}`,
    fecha,
    sede.trim(),
    fasePart,
  ].filter(Boolean);

  // Append score if already played
  if (
    row.estado === "finalizado" &&
    row.marcador_a != null &&
    row.marcador_b != null
  ) {
    parts.push(`${row.marcador_a}-${row.marcador_b} (Final)`);
  } else if (row.estado === "en_vivo" && row.marcador_a != null && row.marcador_b != null) {
    parts.push(`${row.marcador_a}-${row.marcador_b} (En vivo)`);
  }

  return parts.join(" — ");
}

// ---------------------------------------------------------------------------
// partidoToDisplay — richer multi-line block for direct user output
// ---------------------------------------------------------------------------

export function partidoToDisplay(row: PartidoRow): string {
  const teamA = teamLabel(row.equipo_a_codigo, row.equipo_a_nombre, row.equipo_a_desc, row.bandera_a);
  const teamB = teamLabel(row.equipo_b_codigo, row.equipo_b_nombre, row.equipo_b_desc, row.bandera_b);
  const rankA = row.rank_a ? ` (FIFA #${row.rank_a})` : "";
  const rankB = row.rank_b ? ` (FIFA #${row.rank_b})` : "";

  const lines: string[] = [];
  lines.push(`**${teamA}${rankA} vs ${teamB}${rankB}**`);
  lines.push(`Fecha: ${formatFechaCdmx(row.fecha_hora_cdmx)}`);

  if (row.sede_estadio) {
    lines.push(
      `Sede: ${row.sede_estadio}${row.sede_ciudad ? `, ${row.sede_ciudad}` : ""}${row.sede_pais ? ` — ${row.sede_pais}` : ""}`,
    );
  }

  const fase = row.grupo
    ? `Grupo ${row.grupo}`
    : row.fase
      ? capitalize(row.fase.replace(/_/g, " "))
      : null;
  if (fase) lines.push(`Fase: ${fase}`);

  if (row.estado) {
    lines.push(`Estado: ${capitalize(row.estado)}`);
  }

  if (
    (row.estado === "finalizado" || row.estado === "en_vivo") &&
    row.marcador_a != null &&
    row.marcador_b != null
  ) {
    lines.push(`Marcador: ${row.marcador_a} - ${row.marcador_b}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// sedeToDisplay
// ---------------------------------------------------------------------------

export function sedeToDisplay(row: SedeRow): string {
  const lines: string[] = [];
  lines.push(`**${row.nombre}**`);
  lines.push(`Ciudad: ${row.ciudad}, ${row.pais}`);
  if (row.direccion) lines.push(`Dirección: ${row.direccion}`);
  if (row.capacidad) lines.push(`Capacidad: ${row.capacidad.toLocaleString("es-MX")}`);
  if (row.zona_horaria) lines.push(`Zona horaria: ${row.zona_horaria}`);
  if (row.descripcion) lines.push(row.descripcion);
  if (row.google_maps_url) lines.push(`Maps: ${row.google_maps_url}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// fanFestToDisplay
// ---------------------------------------------------------------------------

export function fanFestToDisplay(row: FanFestRow): string {
  const lines: string[] = [];
  lines.push(`**${row.nombre}** — ${row.ciudad}, ${row.pais}`);
  if (row.fecha_inicio || row.fecha_fin) {
    const ini = formatDateOnly(row.fecha_inicio);
    const fin = formatDateOnly(row.fecha_fin);
    if (row.fecha_inicio && row.fecha_fin && row.fecha_inicio !== row.fecha_fin) {
      lines.push(`Fechas: ${ini} – ${fin}`);
    } else {
      lines.push(`Fecha: ${ini}`);
    }
  }
  if (row.horario) lines.push(`Horario: ${row.horario}`);
  if (row.ubicacion) lines.push(`Ubicación: ${row.ubicacion}`);
  if (row.capacidad) lines.push(`Capacidad: ${row.capacidad.toLocaleString("es-MX")}`);
  if (row.entrada_gratis === true) lines.push(`Entrada: Gratis`);
  if (row.descripcion) lines.push(row.descripcion);
  if (row.google_maps_url) lines.push(`Maps: ${row.google_maps_url}`);
  if (row.url_oficial) lines.push(`Sitio oficial: ${row.url_oficial}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// equipoToDisplay
// ---------------------------------------------------------------------------

export function equipoToDisplay(row: EquipoRow): string {
  const lines: string[] = [];
  const flag = row.bandera_emoji ? `${row.bandera_emoji} ` : "";
  lines.push(`**${flag}${row.nombre}** (${row.codigo})`);
  if (row.confederacion) lines.push(`Confederación: ${row.confederacion}`);
  if (row.grupo) lines.push(`Grupo: ${row.grupo}`);
  if (row.fifa_ranking) lines.push(`Ranking FIFA: #${row.fifa_ranking}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// eventoToReadable
// ---------------------------------------------------------------------------

export function eventoToReadable(row: EventoRow): string {
  const min = row.minuto_extra
    ? `${row.minuto ?? "?"}+${row.minuto_extra}'`
    : `${row.minuto ?? "?"}' `;
  const tipo = row.tipo ? capitalize(row.tipo) : "Evento";
  const jugador = row.jugador ?? "Jugador desconocido";
  const asiste = row.jugador_asiste ? ` (asist. ${row.jugador_asiste})` : "";
  const detalle = row.detalle ? ` — ${row.detalle}` : "";
  const equipo = row.equipo_codigo ? ` [${row.equipo_codigo}]` : "";
  return `${min} ${tipo}: ${jugador}${asiste}${equipo}${detalle}`;
}

// ---------------------------------------------------------------------------
// alineacionToReadable
// ---------------------------------------------------------------------------

export function alineacionToReadable(row: AlineacionRow): string {
  const capitan = row.es_capitan ? " (C)" : "";
  const dorsal = row.numero != null ? `#${row.numero} ` : "";
  const posicion = row.posicion ? ` — ${row.posicion}` : "";
  return `${dorsal}${row.jugador ?? "Jugador"}${capitan}${posicion}`;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
