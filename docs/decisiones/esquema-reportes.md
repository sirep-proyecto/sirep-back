# 🤝 Acta de Decisión de Esquema: Homologación `reportes` entre SIREP y RP-TECH (`SIREP-S2-T04`)

**Fecha:** 5 de noviembre de 2026  
**Participantes:**
- **Miguel Quijano** (Líder de Proyecto — SIREP)
- **Adrián Miranda** (Líder Técnico — RP-TECH)
- **Flavio** (Frontend SIREP — Insumo `docs/tabla-comparacion-rptech.md`)

**Estado:** Acordado con RP-TECH (Pendiente de visto bueno final del Coordinador en Etapa 3 para aplicar migración en producción de RP-TECH).

---

## 1. Contexto y Objetivo
De acuerdo con la decisión arquitectónica del proyecto, **SIREP no mantiene un esquema aislado de reportes**, sino que escribe sobre la tabla `public.reportes` de RP-TECH ampliada con los campos presentes en los talonarios físicos de GO Service Latam. Esto evita migrar cientos de registros históricos posteriormente.

Para esta reunión se revisó fila por fila el documento [`docs/tabla-comparacion-rptech.md`](../tabla-comparacion-rptech.md) (31 campos físicos del formulario frente a la Especificación v1 de RP-TECH).

---

## 2. Evaluación de la Propuesta de Entidades (`cliente`, `equipo`, `técnico`)

### Propuesta evaluada:
> *"Cliente, equipo y técnico se guardan como el texto leído y, además, con un vínculo opcional a los clientes, equipos y perfiles de RP-TECH, que se completa en la revisión."*

### Acuerdo con Adrián Miranda:
1. **Conservación del texto manuscrito leído (columnas `text`):**
   - En los reportes antiguos en papel (2023–2025), los nombres de empresas, modelos de equipos y técnicos suelen escribirse con abreviaturas (ej. `"Abregu"`, `"UV-2 cama plana"`, `"Antony"`) o hacer referencia a máquinas/clientes que aún no estaban dados de alta en el catálogo digital de RP-TECH.
   - Por ello, `cliente` (`text`), `serie_equipo` (`text`) y `tecnico_asignado` (`text`) **se guardan siempre con el texto extraído por la IA (o corregido en la bandeja)** para no bloquear la ingesta por Telegram cuando no exista coincidencia exacta de llave foránea.
2. **Vínculos opcionales (`nullable` UUIDs) hacia catálogos de RP-TECH:**
   - Se acuerda incorporar tres llaves foráneas opcionales (`on delete set null`) en la migración de integración con RP-TECH, las cuales pueden vincularse durante o después de la revisión humana en la bandeja:
     - `cliente_id uuid null references public.clientes(id)`
     - `equipo_id uuid null references public.equipos(id)`
     - `tecnico_perfil_id uuid null references public.perfiles(id)`
   - **Regla de negocio:** Para registros con `origen = 'historico'`, estas 3 llaves foráneas son `NULL` al momento de la captura por Telegram y se completan opcionalmente en la bandeja de revisión. Para registros con `origen = 'sistema'` (creados desde la app de RP-TECH), RP-TECH mantiene su validación habitual.

---

## 3. Acuerdo sobre Columnas de la Tabla `reportes`

### 3.1. Columnas de control del histórico (obligatorias para SIREP)
| Columna | Tipo SQL | Regla acordada |
| :--- | :--- | :--- |
| `origen` | `text not null default 'sistema' check (origen in ('historico', 'sistema'))` | Identifica si el reporte provino del archivo físico en papel (`historico`) o nació digitalmente en RP-TECH (`sistema`). |
| `escaneo_id` | `uuid null references public.escaneos(id) on delete set null` | Vincula el reporte con su archivo original sin comprimir en Storage y su huella `SHA-256`. |
| `numero_talonario` | `text null` (indexado) | N° impreso del talonario físico (ej. `000845`). Clave de búsqueda y detección de duplicados de negocio. |

### 3.2. Campos de RP-TECH que pasan a ser opcionales (`nullable`) para el histórico
Los siguientes campos exigidos en reportes digitales nuevos de RP-TECH **no existen en el formulario de papel** y quedan acordados como `nullable` cuando `origen = 'historico'`:
- `fotos_ingreso`
- `fotos_salida`
- `firmas_digitales_pad` (en papel se reemplaza por las banderas booleanas `firma_operador` y `firma_cliente`)
- `numero_caso_crm`

### 3.3. Campos del formulario físico que se agregan a `reportes`
Se acuerda que el formulario físico cuenta con **31 campos**, los cuales se persisten de la siguiente forma:
1. **Columnas dedicadas para consulta, filtrado y exportación directa:**
   - Ya existentes en RP-TECH: `cliente`, `fecha`, `serie_equipo`, `procedimiento`, `codigo_repuesto`, `tecnico_asignado`, `estado_reporte`.
   - Incorporadas en la migración [`20261103000000_reportes_campos_formulario.sql`](../../supabase/migrations/20261103000000_reportes_campos_formulario.sql): `direccion`, `motivo`, `estado_equipo`, `conclusion`, `recomendaciones`, `hora_llegada`, `hora_salida`.
   - Columnas adicionales de detalle técnico acordadas para la migración definitiva en RP-TECH: `telefono`, `contacto`, `ultimo_mantenimiento`, `limpieza_equipo`, `cabezales`, `sistema_proteccion`, `tinta`, `revision_linea_ln`, `revision_linea_lt`, `revision_linea_nt`, `operador`, `repuestos_tipo`, `repuestos_descripcion`, `repuestos_cantidad`, `garantia`, `facturado`, `firma_operador`, `firma_cliente`.
2. **Trazabilidad y auditoría de revisión campo por campo (`campos_extraidos` y `campos_dudosos`):**
   - `campos_extraidos jsonb`: Guarda por cada uno de los 31 campos el valor original leído por el modelo (`valor`), su nivel de `confianza` (`alta`, `media`, `baja`), la bandera `noLeido`, las coordenadas `caja` y el sub-objeto `revision` (`estado`, `valor_corregido`, `revisado_por`, `revisado_en`, `corregido_por`, `corregido_en`), garantizando que **nunca se sobrescriba lo que leyó el modelo**.
   - `campos_dudosos text[]`: Lista de claves pendientes de revisión humana para alimentar la bandeja de forma inmediata.

---

## 4. Cómo se Aplican los Cambios
1. En el repositorio de **SIREP** (`sirep-back`), el esquema base y las columnas de consulta operan mediante las migraciones versionadas en `supabase/migrations/` (100% reproducibles con `supabase db reset`).
2. Para la fase de producción del Sprint 3, se decidió conservar la base de datos actual de **SIREP** aplicando la migración aditiva [`20261114000000_sprint3_integracion_historico_y_vinculos.sql`](../../supabase/migrations/20261114000000_sprint3_integracion_historico_y_vinculos.sql) sin eliminar ni reescribir datos existentes.

---

## 5. Reglas del Reporte Histórico, Vinculación e Importación Idempotente (`SIREP-S3-T09`, `T10`, `T11`)

### 5.1. Reglas del reporte histórico (`SIREP-S3-T09`)
- Todo reporte ingresado desde papel escaneado entra con `origen = 'historico'` y mantiene adjunto su documento original mediante `escaneo_id`.
- Los campos propios del flujo digital de RP-TECH (`fotos_ingreso`, `fotos_salida`, `firmas_digitales_pad`, `numero_caso_crm`) permanecen como columnas `nullable` para `origen = 'historico'`, ya que los talonarios históricos no provienen de un caso CRM previo.
- Al cerrarse o importarse definitivamente, el reporte queda con `estado_reporte = 'aprobado_rptech'`, `bloqueado = true` e `importado_en` sellado con la marca temporal UTC. Cualquier edición posterior exige reapertura explícita (`accion.tipo = 'reabrir'`); de lo contrario responde `409 Conflict`.
- Se garantiza la unicidad del par `(empresa_id, numero_talonario)` mediante índice único parcial (`where numero_talonario is not null`).
- El respaldo íntegro de los 31 campos leídos originalmente por el modelo queda congelado en `datos_originales` (`jsonb`) sin perderse al corregir o exportar.

### 5.2. Vinculación por similitud (`SIREP-S3-T10`)
- Al consultar un reporte (`GET /reportes/:numero`) o cerrarlo (`PATCH /reportes/:numero/importar`), el servicio ejecuta `calcularVinculosSugeridos` contra el catálogo de clientes, equipos y técnicos/perfiles usando similitud normalizada (`>= 0.55` como sugerencia en `vinculos_sugeridos`, y vinculación automática opcional si existe `id` de catálogo con similitud `>= 0.85`).
- El texto manuscrito leído (`cliente`, `serie_equipo`, `tecnico_asignado`) **siempre se conserva intacto**. Si algún catálogo aún no existe o no supera el umbral de similitud, las columnas `cliente_id`, `equipo_id` y `tecnico_perfil_id` permanecen `NULL` para revisión humana manual desde `PATCH /reportes/:numero/vinculos`.

### 5.3. Contrato de importación idempotente (`SIREP-S3-T11`)
- **Endpoint individual:** `PATCH /reportes/:numero/importar` (requiere sesión autenticada).
  - Precondición: el reporte no debe tener campos con `estado_revision === 'pendiente'`. Si existen pendientes, responde `400 Bad Request`.
  - Primera ejecución: marca `estado_reporte = 'aprobado_rptech'`, `bloqueado = true`, `importado_en`, guarda respaldo en `datos_originales`, vincula catálogos con similitud `>= 0.85`, sincroniza `escaneos.estado = 'completo'` y responde `{ status: 'importado_exitoso', ... }`.
  - Reejecuciones posteriores (mismo `numero_reporte`): detecta el estado cerrado sin duplicar registros ni sobrescribir el historial y responde `{ status: 'ya_importado', ... }`.
- **Importación en lote (`SIREP-S3-T13`):** `POST /reportes/importar-lote` y el script `scripts/migrar-revisados-rptech.mjs` procesan todos los reportes históricos ya aprobados/sin pendientes sin re-escanear archivos ni llamar al modelo de IA.
