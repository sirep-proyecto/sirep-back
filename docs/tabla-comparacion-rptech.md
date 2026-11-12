# Mapa de los 31 Campos del Formulario Físico hacia RP-TECH (SIREP-S3-T08)

**Responsables:** Miguel Quijano (SIREP) y Adrián Miranda (RP-TECH).  
**Objetivo:** Definir para cada uno de los **31 campos** del talonario físico de GO Service Latam (más el `numero_talonario` impreso) su **columna de destino en RP-TECH**, la **transformación necesaria** al importar el reporte revisado y cuáles se respaldan en el objeto JSONB `datos_originales` (`campos_extraidos`) para no perder información.

---

## 1. Mapa Completo de los 31 Campos + Identificador de Talonario

Los primeros 10 elementos corresponden a los **campos vitales** definidos en el Sprint 3 (`SIREP-S3-T05`).

| # | Clave en SIREP (`campos-formulario.ts`) | Etiqueta en el Papel | Columna de Destino en RP-TECH | Transformación Necesaria | Respaldo en `datos_originales` (`campos_extraidos`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **0** | `numero_reporte` *(cabecera)* | N° de Talonario | `numero_talonario` *(vital)* | `trim()`, conservar ceros a la izquierda (ej. `"000845"`). Único por `empresa_id`. | Sí (`numero_reporte` y `escaneo_id`) |
| **1** | `fecha` | Fecha | `fecha` *(vital)* | Normalizar de `DD/MM/AA` o `DD-MM-AAAA` a ISO `AAAA-MM-DD` (`date`). | Sí (conserva texto original y confianza) |
| **2** | `tecnico` | Técnico | `tecnico_asignado` *(vital)* | Texto leído/corregido (`trim()`) + búsqueda de vínculo opcional `tecnico_id` en perfiles de RP-TECH (`T10`). | Sí |
| **3** | `empresa` | Empresa / Cliente | `cliente` *(vital)* | Texto leído/corregido (`trim()`) + búsqueda de vínculo opcional `cliente_id` por similitud en clientes de RP-TECH (`T10`). | Sí |
| **4** | `equipo` | Equipo | `serie_equipo` *(vital)* | Texto leído/corregido (`trim()`) + sugerencia de vínculo opcional `equipo_id` en activos de RP-TECH (`T10`). | Sí |
| **5** | `motivo` | Motivo | `motivo` *(vital)* | Texto limpio (`trim()`). Si está en blanco en el papel, `null`. | Sí |
| **6** | `procedimiento` | Procedimiento | `procedimiento` *(vital)* | Texto multilínea íntegro (`trim()`), preservando saltos de línea del técnico. | Sí |
| **7** | `conclusion` | Conclusión | `conclusion` *(vital)* | Texto limpio (`trim()`). Si está en blanco, `null`. | Sí |
| **8** | `hora_llegada` | Hora de llegada | `hora_llegada` *(vital)* | Normalizar a formato 24h `HH:MM` (`text` / `time`). | Sí |
| **9** | `hora_salida` | Hora de salida | `hora_salida` *(vital)* | Normalizar a formato 24h `HH:MM` (`text` / `time`). | Sí |
| **10** | `telefono` | Teléfono (`TELF`) | `telefono` *(o va a `datos_originales`)* | Quitar espacios extremos (`trim()`). Opcional en el papel. | Sí |
| **11** | `direccion` | Dirección | `direccion` | Texto limpio (`trim()`), resuelto con sede del cliente/contacto si estaba borroso. | Sí |
| **12** | `contacto` | Contacto | `contacto` *(o va a `datos_originales`)* | Nombre de quien recepciona en planta (`trim()`). | Sí |
| **13** | `estado_del_equipo` | Estado del Equipo | `estado_equipo` | Opción marcada en casilla: `"Operativo"` o `"Inoperativo"` (o `null` si sin marcar). | Sí |
| **14** | `ultimo_mantenimiento` | Último Mant. | `ultimo_mantenimiento` *(va a `datos_originales` si no hay columna)* | Texto o fecha manuscrita tal como figura en el recuadro (`trim()`). | Sí |
| **15** | `limpieza_equipo` | Limpieza del Equipo | `limpieza_equipo` *(va a `datos_originales` si no hay columna)* | Opción marcada en casilla: `"Limpio"` o `"Sucio"`. | Sí |
| **16** | `cabezales` | Cabezales | `cabezales` *(va a `datos_originales` si no hay columna)* | Opción marcada en casilla: `"Bueno"`, `"Regular"` o `"Malo"`. | Sí |
| **17** | `sistema_proteccion` | Sist. de Protección | `sistema_proteccion` *(va a `datos_originales` si no hay columna)* | Casilla marcada (`"Estab."` / `"UPS"`) y/o texto del recuadro libre. | Sí |
| **18** | `tinta` | Tinta | `tinta` *(va a `datos_originales` si no hay columna)* | Texto limpio (`trim()`). | Sí |
| **19** | `revision_linea_ln` | Revisión de Líneas `L+N` | `revision_linea_ln` *(va a `datos_originales` si no hay columna)* | Valor eléctrico medido (`trim()`, ej. `"220V"`). | Sí |
| **20** | `revision_linea_lt` | Revisión de Líneas `L+T` | `revision_linea_lt` *(va a `datos_originales` si no hay columna)* | Valor eléctrico medido (`trim()`). | Sí |
| **21** | `revision_linea_nt` | Revisión de Líneas `N+T` | `revision_linea_nt` *(va a `datos_originales` si no hay columna)* | Valor eléctrico medido (`trim()`). | Sí |
| **22** | `operador` | Operador | `operador` *(va a `datos_originales` si no hay columna)* | Nombre del operador del equipo en planta (`trim()`). | Sí |
| **23** | `recomendaciones` | Recomendaciones | `recomendaciones` | Texto multilínea limpio (`trim()`). | Sí |
| **24** | `repuestos_tipo` | Repuestos Requeridos (Tipo) | `repuestos_tipo` *(va a `datos_originales` si no hay columna)* | Opción marcada: `"Venta"`, `"Descarte"` o `"Garantía"`. | Sí |
| **25** | `codigo_repuesto` | Repuestos: Código | `codigo_repuesto` | Texto con códigos separados por salto de línea (`trim()`). | Sí |
| **26** | `repuestos_descripcion` | Repuestos: Descripción | `repuestos_descripcion` *(va a `datos_originales` si no hay columna)* | Texto con descripciones de repuestos por fila (`trim()`). | Sí |
| **27** | `repuestos_cantidad` | Repuestos: Cantidad | `repuestos_cantidad` *(va a `datos_originales` si no hay columna)* | Cantidades por fila convertidas a texto (`trim()`). | Sí |
| **28** | `garantia` | Garantía | `garantia` *(va a `datos_originales` si no hay columna)* | Booleano de casilla transformado a `"Sí"` / `"No"` (o `null` si en blanco). | Sí |
| **29** | `facturado` | Facturado | `facturado` *(va a `datos_originales` si no hay columna)* | Booleano de casilla transformado a `"Sí"` / `"No"` (o `null` si en blanco). | Sí |
| **30** | `firma_operador` | Firma del Operador | `firma_operador` *(va a `datos_originales` si no hay columna)* | Detección de firma manuscrita transformada a `"Sí"` / `"No"`. | Sí |
| **31** | `firma_cliente` | Firma del Cliente | `firma_cliente` *(va a `datos_originales` si no hay columna)* | Detección de firma manuscrita transformada a `"Sí"` / `"No"`. | Sí |

---

## 2. Campos Propios de RP-TECH que el Papel No Trae (`SIREP-S3-T09`)

Para todo registro con `origen = 'historico'`:
- **`numero_caso_crm` / caso previo:** Opcional (`NULL`). Un reporte histórico en papel entra directamente cerrado y bloqueado sin exigir orden previa.
- **`fotos_ingreso` y `fotos_salida`:** Opcionales (`NULL`). El respaldo visual del histórico es el PDF/imagen original vinculado mediante `escaneo_id` (`ruta_original`).
- **`firmas_digitales_pad`:** Opcional (`NULL`), sustituido por la constancia en papel (`firma_operador` y `firma_cliente`).
- **`datos_originales` (`campos_extraidos` JSONB):** Almacena siempre los **31 campos** con el valor leído por la IA, su nivel de confianza, coordenadas de recorte (`caja`), el valor corregido, quién lo corrigió y cuándo.
