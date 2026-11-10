# 📑 Informe Semanal — Backend (`sirep-back`)
**Semana:** Semana 1 (Lunes 2 al Viernes 6 de noviembre de 2026)  
**Proyecto:** SIREP (Sistema de Reconocimiento y Extracción de Reportes Técnicos)  
**Integrantes Backend:** Luciano (Backend 1), Kevin (Backend 2) y Miguel Quijano (Líder)

---

## 1. Resumen Ejecutivo
Durante la primera semana se completaron las dos primeras etapas del backend de SIREP:
1. **Etapa 1 (Base Técnica):** Construcción del proyecto NestJS con TypeScript en modo estricto, integración con Supabase CLI mediante 3 migraciones SQL reproducibles (`supabase db reset`), bot de Telegram con validación de `secret_token`, almacenamiento del escaneo original sin comprimir en Storage, conversión de PDF a PNG por página, detección de duplicados en dos niveles (`SHA-256` y N° de talonario), pieza de IA intercambiable (`Gemini` y `OpenAI`) y API de revisión sin sobrescribir la lectura original del modelo.
2. **Etapa 2 (Sprint 2 — Prueba de Viabilidad):** Desarrollo del script autónomo `scripts/evaluar-muestra.mjs` y el motor de normalización `src/ia-extractor/normalizacion.ts`, limpieza total de restos de SIREGG (`0` resultados de `gastos` y `Hallazgo 37.4-E`) y ejecución de las corridas comparativas sobre los 25 reportes reales a `1600 px` y `2400 px`.

---

## 2. Estado frente a las Tareas

| Etapa / Tarea | Responsable | Estado | Evidencia Principal |
| :--- | :--- | :---: | :--- |
| **Día 1 — Backend 1:** Pieza de IA intercambiable (`Gemini` / `OpenAI`) | Luciano | ✅ Completado | `src/ia-extractor/` (`types.ts`, `gemini.proveedor.ts`, `openai.proveedor.ts`, `ia-extractor.factory.ts`) |
| **Día 1 — Backend 2:** Base NestJS, Supabase CLI, Bot Telegram y Storage | Kevin | ✅ Completado | `src/escaneos/`, `src/telegram/`, `src/reportes/`, `supabase/migrations/` |
| **SIREP-S2-T06:** Transcripción y revisión cruzada de la muestra (25 reportes) | Todo el equipo | ✅ Completado | `muestra/transcripcion_manual.csv`, `muestra/registro_muestra.csv` |
| **SIREP-S2-T07:** Script de evaluación `scripts/evaluar-muestra.mjs` y normalización | Luciano | ✅ Completado | `scripts/evaluar-muestra.mjs`, `src/ia-extractor/normalizacion.ts` |
| **SIREP-S2-T08:** Corridas de la muestra con Gemini (1600px / 2400px) y OpenAI | Kevin | ✅ Completado | `evaluacion_gemini_1600px.csv`, `evaluacion_gemini_2400px.csv`, `evaluacion_openai_1600px.csv` |
| **SIREP-S2-T09:** Limpieza del repositorio (0 restos de SIREGG, migraciones limpias) | Kevin | ✅ Completado | `docs/VERIFICACION_T09.md`, `Caddyfile`, `docker-compose.yml` |
| **SIREP-S2-T04 y T05:** Acta de esquema RP-TECH e Informe de Viabilidad | Miguel Quijano | ✅ Completado | `docs/decisiones/esquema-reportes.md`, `docs/prueba-viabilidad/informe.md` |

---

## 3. Estado de Pruebas Automatizadas
Toda la batería de pruebas unitarias en **Jest** se ejecuta sin conexión a internet ni consumo de API real:
- **Suites aprobadas:** **7 de 7 (100% PASS)**
- **Total de pruebas:** **124 de 124 tests pasando**
  - `src/ia-extractor/ia-extractor.spec.ts`: Contrato de IA, cambio por variable de entorno, cálculo de tokens/costos, errores HTTP y campos no leídos.
  - `src/ia-extractor/normalizacion.spec.ts`: 16 tests de reglas de comparación Sprint 2 (mayúsculas, tildes, espacios dobles, fechas `AAAA-MM-DD`, horas `HH:MM`, coeficiente Sørensen-Dice, `vacío correcto` y `no leído`).
  - `src/escaneos/escaneos.service.spec.ts` y `escaneos.util.spec.ts`: Huella `SHA-256`, duplicado de N° de talonario, conversión de PDF a PNG, compresión JPEG con `sharp` y reversión de Storage ante fallos.
  - `src/reportes/reportes.service.spec.ts` y `reportes.mapper.spec.ts`: Preservación del valor del modelo, auditoría de correcciones y control de concurrencia `409 Conflict`.
  - `src/telegram/telegram-sirep.spec.ts`: Validación de `X-Telegram-Bot-Api-Secret-Token` y respuestas del bot.

---

## 4. Registro de Incidencias (`FEEDBACK`) y Pendientes
- `FEEDBACK:SIREP-S2-T08-A`: OpenAI (`gpt-4o-mini`) devolvió error `HTTP 429: insufficient_quota (credit_balance_exhausted)` en los 25 reportes de la muestra debido al agotamiento del crédito en la clave temporal de pruebas. El script capturó el error mediante `ProveedorIaError` y lo dejó documentado en `evaluacion_openai_1600px.csv`.
- **Pendientes para siguientes etapas:**
  - Integración final en `main` (`SIREP-S2-T01`) una vez finalizada la revisión del coordinador.
  - Diálogo interactivo en Telegram para preguntar campos dudosos con recorte (Etapa 4).
  - Autenticación homologada con RP-TECH y ocultamiento de Swagger en producción (Etapa 5).

---

## 5. Decisiones que se Necesitan del Coordinador
1. **Aprobación del modelo y resolución recomendados:** Confirmar el uso de `gemini-3.8-flash` con imágenes de `1600 px` de lado largo ($0.00111 USD por reporte, 99.74% de precisión).
2. **Aprobación del esquema acordado con Adrián Miranda (`docs/decisiones/esquema-reportes.md`):** Autorizar la migración en RP-TECH conservando `cliente`, `serie_equipo` y `tecnico_asignado` como texto leído más las 3 llaves foráneas opcionales (`cliente_id`, `equipo_id`, `tecnico_perfil_id`).

---

## 6. Sección Individual por Integrante

### 👤 Luciano (Backend 1 — Pieza de IA y Script de Evaluación)
* **Qué hizo:**
  - Diseñó e implementó la pieza de IA intercambiable (`src/ia-extractor/`) para Gemini y OpenAI con selección por variable de entorno (`IA_PROVIDER`), cálculo de costos/tokens y reintentos exponenciales ante sobrecarga (`429`/`503`).
  - Construyó el motor de normalización y comparación (`src/ia-extractor/normalizacion.ts`) con limpieza de diacríticos, normalización de fechas/horas, similitud de texto libre mediante Sørensen-Dice y aprendizaje contextual de correcciones previas (`aplicarCorreccionesAprendidas`).
  - Desarrolló el script CLI `scripts/evaluar-muestra.mjs` con parseo CSV RFC 4180, conversión de PDF a imagen en memoria, guardado de salidas crudas JSON y exportación CSV con UTF-8 BOM sin tocar Supabase.
  - Creó las suites `ia-extractor.spec.ts` y `normalizacion.spec.ts` y transcribió 6 reportes de la muestra.
* **Qué problemas tuvo y cómo los resolvió:**
  - *Problema 1:* El endpoint multimodal de OpenAI rechaza `application/pdf` directo, mientras que los reportes escaneados llegan en PDF de 2 páginas. *Solución:* Se estandarizó el flujo para convertir primero cada página del PDF a imagen con `pdfjs-dist` y `sharp`, entregando siempre `image/jpeg` a cualquier proveedor.
  - *Problema 2:* En campos de texto largo (`procedimiento`, `conclusion`), una mínima diferencia de puntuación hacía que una comparación exacta (`===`) marcara como error lecturas humanas y de IA equivalentes. *Solución:* Implementó el coeficiente de bigramas de Sørensen-Dice con umbral `>= 0.82` para `correcto` y `0.50–0.81` para `dudoso`.
* **Qué aprendió:**
  - Cómo estructurar un adaptador multimodal agnóstico al proveedor y por qué separar `vacío correcto` de `no leído` es indispensable cuando el formulario físico tiene más de 15 campos opcionales que suelen quedar en blanco.
* **Qué partes hizo con ayuda de IA:**
  - Se apoyó en IA para afinar las expresiones regulares de fechas latinoamericanas (`DD/MM/AA`, `DD-MM-AAAA`) y la estructura base de pruebas en Jest, revisando y probando manualmente cada función.

### 👤 Kevin (Backend 2 — Base NestJS, Supabase, Bot de Telegram y Corridas de Muestra)
* **Qué hizo:**
  - Levantó la arquitectura base en NestJS, el servicio de Supabase (`SupabaseService`) y las 3 migraciones SQL en `supabase/migrations/`.
  - Implementó el webhook de Telegram (`TelegramController`, `TelegramService`) con validación de `secret_token`, descarga segura de hasta 20 MB y formateo HTML escapado del resumen de cada reporte.
  - Implementó `EscaneosService` y `ReportesService` con guardado del original sin comprimir en Storage, detección de duplicados por huella `SHA-256` y N° de talonario, control de concurrencia optimista (`409`) y notificaciones en tiempo real (`EventosGateway`).
  - Ejecutó la limpieza completa de deuda técnica (`SIREP-S2-T09`, 0 restos de `gastos` o `Hallazgo 37.4-E`) y corrió las evaluaciones de los 25 reportes a `1600 px` y `2400 px` (`SIREP-S2-T08`).
* **Qué problemas tuvo y cómo los resolvió:**
  - *Problema 1:* Si dos envíos idénticos llegaban casi al mismo tiempo por Telegram, la consulta previa de duplicados dejaba una condición de carrera. *Solución:* Creó la migración `20261102000100_sirep_huella_unica_y_trigger.sql` con el índice único `idx_escaneos_huella_empresa` y manejo del código PostgreSQL `23505`.
  - *Problema 2:* Si la IA fallaba después de haber subido el PDF a Storage, quedaban archivos huérfanos. *Solución:* Implementó `limpiarStorage(subidos)` en el bloque `catch` de `EscaneosService` para revertir los archivos subidos si el modelo devuelve error.
* **Qué aprendió:**
  - Cómo garantizar integridad transaccional entre un servicio de almacenamiento de objetos (Supabase Storage) y una tabla relacional cuando interviene una llamada externa a IA que puede fallar.
* **Qué partes hizo con ayuda de IA:**
  - Uso de IA para auditar referencias residuales en archivos de configuración (`Caddyfile`, `docker-compose.yml`) y estructurar mocks de Supabase en los tests unitarios de `escaneos.service.spec.ts` y `reportes.service.spec.ts`.
