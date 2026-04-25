# Cómo funciona Alessandra (flujo en palabras)

Alessandra es el asistente ciudadano de la Alcaldía Cuauhtémoc. La gente le escribe por chat web o por WhatsApp (vía Twilio) y ella responde con información del Mundial, ayuda para mujeres en situación de violencia (Puntos Violeta) o levanta reportes ciudadanos (baches, alumbrado, fugas, etc.).

Este documento explica, en palabras, **qué pasa entre el momento en que el usuario manda un mensaje y el momento en que recibe la respuesta**.

---

## 1. Llega el mensaje

El mensaje puede entrar por dos puertas:

- **Chat web** (`/chat`): el navegador manda el texto (y si hay foto o ubicación, los adjuntos) directo a la API interna.
- **WhatsApp**: Twilio recibe el mensaje del usuario y lo reenvía como webhook a Alessandra. Si el usuario mandó una foto, Alessandra la baja de Twilio y la sube a su propio almacenamiento (Supabase Storage) para tenerla disponible. Como WhatsApp espera respuesta rápida, el webhook **acusa recibo de inmediato** y procesa el turno en segundo plano; cuando la respuesta está lista, Alessandra se la manda al usuario por la API REST de Twilio como mensaje saliente.

Sea cual sea la puerta, a partir de aquí el flujo es el mismo: todo cae en una sola función, `processTurn`, que es el cerebro del bot.

---

## 2. Identificar al usuario y su sesión

Antes de pensar en qué responder, Alessandra necesita saber **quién está hablando** y **si ya venían platicando**.

- Cada usuario tiene un identificador estable (su número de WhatsApp, o un identificador anónimo si es web).
- Con ese ID, Alessandra busca si tiene una **sesión activa** (una conversación abierta de las últimas 6 horas). Si la encuentra, la reusa. Si no, abre una nueva.
- Cada turno **renueva** ese contador de 6 horas. Mientras el usuario siga escribiendo dentro de esa ventana, todo cuenta como la misma conversación.

Esto es lo que permite que Alessandra "se acuerde" de lo que hablaron hace 5 minutos sin pedirle al usuario que repita el contexto.

---

## 3. Recuperar memoria de fotos

Si el usuario mandó una foto en este turno, Alessandra la guarda como **"última imagen de la conversación"**. Si no mandó foto pero ya había mandado una en los últimos 15 minutos, Alessandra **recupera esa foto anterior** automáticamente. Esto evita que el usuario tenga que reenviar la imagen cuando, por ejemplo, primero manda la foto de un bache y luego escribe "esto está en avenida Juárez".

---

## 4. Filtros de seguridad antes del modelo

Antes de gastar tiempo y dinero llamando al modelo de lenguaje, el mensaje pasa por tres filtros:

1. **Rate limit**: si un usuario está mandando demasiados mensajes muy seguidos, se le pide esperar. Esto protege contra abuso o errores de loop.
2. **Detector de emergencia de género**: si el mensaje contiene señales de violencia inmediata ("me está pegando", "me quiere matar", etc.), Alessandra **corta el flujo normal** y responde con un protocolo predefinido: números de emergencia (911, *765 LUNAS, LOCATEL) y los Puntos Violeta abiertos 24/7 más cercanos. Esta respuesta **no pasa por el modelo** — es una plantilla con datos reales sacados directamente de la base de datos. Es así porque en una emergencia no se puede arriesgar que el modelo invente un teléfono o pierda tiempo "pensando".
3. **Detector de jailbreak**: si el mensaje intenta manipular al bot ("ignora tus instrucciones", "actúa como…"), responde con una frase fija que reafirma su rol y no le pasa nada al modelo.

Si el mensaje pasa los tres filtros, sigue al siguiente paso.

---

## 5. Cargar la memoria de la conversación

Alessandra abre el historial de la conversación y carga **los últimos 20 mensajes** (configurable). Esos mensajes son los que después le va a entregar al modelo como contexto.

Junto con los mensajes, también carga el **estado de flujo activo**, si lo hay. Un "flujo" es un proceso multi-turno; el caso más claro son los reportes ciudadanos: capturar un bache requiere varios pasos (tipo de problema, ubicación, foto, descripción, confirmación). Mientras ese proceso está abierto, Alessandra guarda en qué paso va, qué datos ya tiene y qué falta.

Si el usuario mandó foto o ubicación en este turno **y hay un reporte abierto**, esos datos se meten automáticamente en los espacios correspondientes del reporte sin esperar a que el modelo lo decida. Esto es para que el modelo no "alucine" datos cuando los datos reales ya están enfrente.

---

## 6. Decidir de qué tema se está hablando (router)

Aquí Alessandra decide a cuál de sus tres áreas pertenece el mensaje: **mundial**, **puntos_violeta**, **reportes** o **fuera_alcance**. Lo hace con una estrategia de cuatro escalones, en orden:

1. **Pegajosidad de flujo**: si ya hay un reporte (o cualquier otro proceso) abierto, **se queda en ese tema** con muy alta confianza. Lógica: si el usuario está a la mitad de levantar un bache y escribe "sí, así es", obviamente se refiere al bache, no a un partido.

2. **Heurística por palabras clave**: una serie de expresiones regulares revisa si el mensaje contiene palabras del vocabulario de cada dominio ("estadio", "fan fest" → mundial; "violencia", "ayuda mujer" → violeta; "bache", "alumbrado" → reportes). Si una gana por margen claro, se decide ahí mismo, **sin llamar a ningún modelo**.

3. **Filtro de fuera de alcance**: si ningún dominio dio señal alguna ("¿cuál es la capital de Francia?"), se marca como fuera de alcance directamente.

4. **Modelo clasificador como último recurso**: solo cuando hay señal débil pero no clara, se llama a un modelo pequeño y rápido (Gemini Flash) **una sola vez, sin reintentos**, para que decida. Esto mantiene barato el clasificador.

Hay una excepción: si el usuario adjuntó una foto y escribió algo como "describe esta imagen", aunque el router no esté seguro, se **sesga hacia reportes** para que la herramienta de análisis de imagen quede disponible.

---

## 7. Construir las instrucciones del modelo

Una vez decidido el dominio, Alessandra arma las instrucciones que le va a dar al modelo. Ese "system prompt" tiene tres partes pegadas:

1. **Instrucciones base**: quién es Alessandra, su tono, qué nunca debe inventar, cómo citar datos de las herramientas, etc.
2. **Pista de dominio**: un párrafo extra específico al tema detectado ("para mundial, presenta máximo 3 partidos por respuesta", "para violeta, nunca inventes teléfonos", etc.).
3. **Bloqueo de idioma**: detecta si el usuario escribió en español, inglés, portugués, francés o italiano, y le ordena al modelo responder en ese mismo idioma. Esto se hace por las visitas internacionales del Mundial.

Además, se inyecta una línea de contexto con el ID de conversación, el ID de usuario y los adjuntos (lat/lng/imagen). Las herramientas que necesitan estos datos los reciben de aquí, no del modelo (para que el modelo no se los invente).

---

## 8. El modelo decide qué herramientas usar

Ahora sí, Alessandra le pasa al modelo principal (`gpt-4o-mini` por defecto):

- Sus instrucciones (las del paso anterior).
- El historial reciente (los 20 mensajes anteriores).
- El mensaje nuevo del usuario.
- El catálogo completo de **herramientas disponibles** (16 en total: 5 de mundial, 3 de violeta, 7 de reportes, 1 de SQL analítico).

El modelo lee todo y decide:
- **Responder directo** si la pregunta no necesita datos (saludos, "¿qué eres?").
- **Llamar a una o varias herramientas** si necesita información real. Por ejemplo, "¿a qué hora juega México mañana?" hace que el modelo decida llamar a `mundial_partidos_buscar` con `equipo: "México"` y `fecha: <mañana>`. La herramienta consulta la base de datos, le devuelve los resultados, y entonces el modelo redacta la respuesta usando esos datos.

El modelo puede encadenar **hasta 15 pasos** en un mismo turno (por ejemplo: buscar un partido, después buscar info de la sede de ese partido, y después escribir la respuesta). El bot deja que el modelo decida ese encadenamiento; no está hardcodeado.

La temperatura es **0** (cero creatividad) cuando el dominio es Puntos Violeta — porque ahí cualquier invento de un teléfono o dirección puede poner a alguien en riesgo. Para los demás dominios es 0.3, que permite redacción natural sin alejarse de los datos.

---

## 9. Filtro post-modelo: verificación de citas

Cuando el modelo termina de redactar, **antes de enviar la respuesta al usuario**, se hace una verificación: si el modelo dijo un teléfono, dirección o folio, ese dato **debe aparecer literalmente** en los resultados que devolvieron las herramientas. Si dice un teléfono que la herramienta nunca devolvió, es alucinación.

- Si la verificación pasa, la respuesta se envía.
- Si falla, se le da al modelo **una segunda oportunidad**: se le devuelve su propia respuesta junto con una instrucción extra ("reescríbelo usando ÚNICAMENTE los datos de las herramientas"). Si esa segunda respuesta también falla, se le manda al usuario un mensaje genérico admitiendo que no se pudo generar una respuesta verificable.

Esta verificación está activada para Puntos Violeta y Reportes (donde inventar datos es peligroso o confuso). Para Mundial está desactivada porque el modelo parafrasea horarios de forma natural ("a las 4 de la tarde" en vez de "16:00") y el verificador daba demasiados falsos positivos.

---

## 10. Guardar en memoria

La respuesta final, junto con el mensaje del usuario, se **anexa al historial** de la conversación en la base de datos. Así, cuando el usuario escriba el siguiente mensaje, el paso 5 podrá cargar ese intercambio como parte de los 20 mensajes recientes y el modelo verá la continuidad.

También se guardan, asociados al mensaje del asistente:
- Las herramientas que se llamaron (con sus argumentos y resultados).
- Cuántos tokens consumió.
- Cuánto tardó.

Esto sirve después para depurar y para mostrar el "Ver razonamiento" en la interfaz web.

Por último, se renueva el contador de 6 horas de la sesión.

---

## 11. Devolver al usuario

- **Web**: la respuesta se devuelve como JSON al navegador, que la pinta en la burbuja del chat.
- **WhatsApp**: la respuesta se convierte de Markdown al formato que entiende WhatsApp (sin links largos, con asteriscos en vez de negritas tipo `**`, etc.) y se manda al usuario por la API de Twilio. Si la respuesta es muy larga, se parte en varios mensajes.

---

## Cómo se acuerda Alessandra de lo anterior — resumen

La memoria funciona en **tres capas**, todas guardadas en Supabase:

1. **Sesión activa por usuario**: identifica que sigue siendo la misma conversación durante 6 horas. Se renueva en cada turno.
2. **Historial de mensajes**: cada turno (entrada del usuario + respuesta de Alessandra) se anexa a un arreglo de mensajes en la conversación. Cada vez que llega un mensaje nuevo, se cargan los últimos 20 y se le entregan al modelo como contexto. Así el modelo "ve" la conversación completa y puede responder de forma coherente sin que el usuario tenga que repetir nada.
3. **Estado de flujo**: si el usuario está en medio de un proceso multi-turno (típicamente un reporte ciudadano), Alessandra guarda en qué paso va y qué datos ya tiene. Ese estado expira a los 30 minutos de inactividad. Mientras esté vivo, fuerza al router a quedarse en ese tema, evitando que el bot "se distraiga" si el usuario mete una pregunta tangencial.

La combinación de estas tres capas es lo que hace que Alessandra se sienta como una conversación continua y no como un bot que responde mensaje por mensaje sin contexto.
