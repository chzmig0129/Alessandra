import "dotenv/config";
import postgres from "postgres";

// Script de setup (correr UNA vez) para meter el partido demo Pumas vs Juárez
// ligado al fixture de API-Sports, en el Estadio Azteca.
// Añade también las columnas api_fixture_id y api_team_id para linkear con el API.

const sql = postgres(process.env.SUPABASE_DB_URL, { max: 1, ssl: "require" });

try {
  console.log("1) Agregando columnas api_* si no existen...");
  await sql`ALTER TABLE "mundial-fifa".partidos ADD COLUMN IF NOT EXISTS api_fixture_id BIGINT`;
  await sql`ALTER TABLE "mundial-fifa".equipos ADD COLUMN IF NOT EXISTS api_team_id BIGINT`;

  console.log("2) Insertando equipos PUM y JUA (upsert)...");
  await sql`
    INSERT INTO "mundial-fifa".equipos (codigo, nombre, nombre_en, confederacion, bandera_emoji, api_team_id)
    VALUES
      ('PUM', 'Pumas UNAM', 'Pumas UNAM', 'CONCACAF', '🐾', 2286),
      ('JUA', 'FC Juárez', 'FC Juarez', 'CONCACAF', '⚽', 2298)
    ON CONFLICT (codigo) DO UPDATE
      SET nombre = EXCLUDED.nombre,
          nombre_en = EXCLUDED.nombre_en,
          bandera_emoji = EXCLUDED.bandera_emoji,
          api_team_id = EXCLUDED.api_team_id
  `;

  console.log("3) Buscando sede_id del Estadio Azteca...");
  const [azteca] = await sql`
    SELECT id FROM "mundial-fifa".sedes
    WHERE lower(nombre) ILIKE '%azteca%' LIMIT 1
  `;
  if (!azteca) throw new Error("No encontré Estadio Azteca en sedes");
  console.log("   sede_id:", azteca.id);

  console.log("4) Insertando (o actualizando) partido demo Pumas vs Juárez...");
  await sql`
    INSERT INTO "mundial-fifa".partidos (
      numero_partido, fase, jornada, fecha_utc, fecha_local,
      equipo_local_codigo, equipo_visitante_codigo,
      sede_id, estado, api_fixture_id
    ) VALUES (
      9999, 'grupos', 'Liga MX (demo live)',
      now(), (now() AT TIME ZONE 'America/Mexico_City'),
      'PUM', 'JUA',
      ${azteca.id}, 'en_vivo', 1492599
    )
    ON CONFLICT (numero_partido) DO UPDATE
      SET equipo_local_codigo = EXCLUDED.equipo_local_codigo,
          equipo_visitante_codigo = EXCLUDED.equipo_visitante_codigo,
          sede_id = EXCLUDED.sede_id,
          estado = EXCLUDED.estado,
          api_fixture_id = EXCLUDED.api_fixture_id
  `.catch(async (err) => {
    // Si no hay constraint único en numero_partido, hacemos upsert manual.
    if (String(err.message).includes("no unique")) {
      const [existing] = await sql`
        SELECT id FROM "mundial-fifa".partidos WHERE numero_partido = 9999 LIMIT 1
      `;
      if (existing) {
        await sql`
          UPDATE "mundial-fifa".partidos
          SET equipo_local_codigo = 'PUM',
              equipo_visitante_codigo = 'JUA',
              sede_id = ${azteca.id},
              estado = 'en_vivo',
              api_fixture_id = 1492599,
              fecha_utc = now(),
              fecha_local = (now() AT TIME ZONE 'America/Mexico_City')
          WHERE id = ${existing.id}
        `;
      } else {
        await sql`
          INSERT INTO "mundial-fifa".partidos (
            numero_partido, fase, jornada, fecha_utc, fecha_local,
            equipo_local_codigo, equipo_visitante_codigo,
            sede_id, estado, api_fixture_id
          ) VALUES (
            9999, 'grupos', 'Liga MX (demo live)',
            now(), (now() AT TIME ZONE 'America/Mexico_City'),
            'PUM', 'JUA',
            ${azteca.id}, 'en_vivo', 1492599
          )
        `;
      }
    } else {
      throw err;
    }
  });

  const [p] = await sql`
    SELECT id, numero_partido, estado, api_fixture_id
    FROM "mundial-fifa".partidos WHERE numero_partido = 9999
  `;
  console.log("   partido OK:", p);
  console.log("\n✅ Setup completo. Corre `npm run sync` (o arranca el server) para jalar datos del API.");
} catch (e) {
  console.error("FATAL:", e.message);
  process.exit(1);
} finally {
  await sql.end();
}
