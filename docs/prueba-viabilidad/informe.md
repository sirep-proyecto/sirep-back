# Informe de Evaluacion de Viabilidad y Muestra a Ciegas (SIREP-S3-T14, SIREP-S3-T15 y SIREP-S4-T09)

## 1. Resumen ejecutivo

Este informe presenta la medicion real de desempeno del extractor de IA en produccion sobre una muestra a ciegas de 20 reportes reales (`SIREP-S3-T14`, `SIREP-S3-T15` y `SIREP-S4-T09`), corrigiendo la medicion preliminar del Sprint 2 que habia arrojado un `99.74%` en `1600 px` (y `99.35%` en `2400 px`, con un incremento de latencia del `10.6%` de `12.2 s` a `13.5 s` en aquel experimento no ciego).

En la evaluacion a ciegas actual, cuatro integrantes transcribieron manualmente los 31 campos de los 20 reportes observando unicamente los escaneos originales (sin acceso a `campos_extraidos` ni a la salida del modelo), con revision cruzada independiente antes de ejecutar `scripts/evaluar-muestra.mjs --desde-bd=true`.

Resultados principales sobre los 620 campos evaluados (20 reportes x 31 campos, 0 campos sin referencia):

- **Precision global (sobre 620 campos):** `90.32%` (`560 / 620`), compuesta por `170` aciertos en campos con dato manuscrito (`correcto`) y `390` aciertos en casilleros en blanco (`vacío correcto`).
- **Precision excluyendo campos marcados como `ilegible` por humano:** `92.26%` (`560 / 607`).
- **Precision estricta sobre campos manuscritos llenos y legibles:** `79.44%` (`170 / 214`), frente a `99.24%` (`390 / 393`) en casilleros vacios.
- **Discrepancias totales:** `60 / 620` (`9.68%`), desglosadas en `40` errores (`6.45%`), `4` no leidos (`0.65%`) y `16` dudosos (`2.58%`).
- **Errores con confianza `alta`:** `36 / 620` (`5.81%` del total evaluado; `6.20%` dentro de los `581` campos clasificados con confianza `alta`).
- **Carga promedio de bandeja de revision (`campoRequiereRevision`):** `5.2%` (`32 / 620`, equivalente a `5.16%`; peor caso en el reporte `000434` con `6 / 31`).
- **Costo y latencia reales observados en BD:** `$0.03934 USD` acumulados en los 20 reportes (`$0.001967 USD` promedio por reporte; `$0.000984 USD` promedio por pagina sobre `40` paginas procesadas) y `54966 ms` de tiempo promedio por reporte (mediana `37232 ms`).

La diferencia entre el `99.74%` preliminar del Sprint 2 y el `90.32%` global (`79.44%` en campos manuscritos llenos) demuestra el impacto del sesgo de confirmacion cuando el transcriptor conoce la salida previa del modelo y confirma que, aunque la extraccion sigue siendo economicamente viable a menos de un quinto de centavo por reporte, la revision humana selectiva y la doble revision aleatoria son indispensables en campos criticos manuscritos.

---

## 2. Metodologia y composicion de la muestra a ciegas

Para evitar sesgos de confirmacion y cumplir con `SIREP-S4-T09`, se seleccionaron 20 reportes reales almacenados en produccion (incluyendo tanto casos con alta concentracion de campos marcados para revision como casos ya cerrados) y se descargaron exclusivamente sus imagenes escaneadas sin exponer `campos_extraidos`.

### 2.1 Protocolo de transcripcion a ciegas

1. Cada lote de 5 reportes fue transcrito manualmente en formato RFC 4180 (`muestra/transcripcion_manual.csv`) siguiendo las columnas oficiales de `docs/plantilla-transcripcion.csv`.
2. Cuando un casillero estaba en blanco en la imagen se registro `vacío`; cuando el trazo manuscrito resultaba indescifrable al ojo humano se registro `ilegible`.
3. Ningun transcriptor tuvo acceso a la prediccion de Gemini antes de cerrar `muestra/transcripcion_manual.csv` y `muestra/registro_muestra.csv`.
4. Se realizo revision cruzada entre pares sobre los 4 lotes antes de ejecutar `scripts/evaluar-muestra.mjs --desde-bd=true`.

### 2.2 Distribucion de los 20 reportes

| Dimension | Categoria | Cantidad |
| :--- | :--- | :---: |
| Diseno de talonario | `post-000700` | 11 |
| Diseno de talonario | `pre-000700` | 7 |
| Diseno de talonario | `otro` | 2 |
| Legibilidad percibida | `buena` | 13 |
| Legibilidad percibida | `regular` | 5 |
| Legibilidad percibida | `mala` | 2 |
| Anio del reporte | `2025` | 10 |
| Anio del reporte | `2026` | 5 |
| Anio del reporte | `sin_fecha` | 3 |
| Anio del reporte | `2024` | 2 |

Segun la distribucion de referencia sobre los 620 campos:

- **Campos con valor manuscrito legible:** `214 / 620` (`34.52%`).
- **Casilleros en blanco (`vacío`):** `393 / 620` (`63.39%`).
- **Trazos marcados como `ilegible` por humano:** `13 / 620` (`2.10%`).

---

## 3. Configuracion evaluada, tiempos y costos en produccion

Al inspeccionar `public.escaneos.metadatos.uso` en la base de datos de produccion para los 20 reportes de la muestra, se verifico que el `100%` (`20 / 20`) fue procesado con la misma configuracion operativa:

- **Proveedor y modelo:** `gemini / gemini-3.5-flash-lite`
- **Resolucion objetivo configurada (`IA_LADO_LARGO_PX`):** `1600 px` (preprocesado `pre=false`)
- **Paginas totales procesadas en la muestra:** `40` paginas (`2.0` paginas promedio por reporte; rango de `1` a `5` paginas por PDF)
- **Costo acumulado (20 reportes):** `$0.03934 USD` (`$0.039342 USD` exacto)
- **Costo promedio por reporte:** `$0.001967 USD` (minimo `$0.000914 USD`, maximo `$0.004853 USD`)
- **Costo promedio por pagina:** `$0.000984 USD`
- **Latencia por reporte:** promedio `54966 ms`, mediana `37232 ms`, minimo `4878 ms`, maximo `263609 ms` (los reportes multipagina de 3 a 5 hojas concentran los tiempos mayores y reintentos ante limites de tasa de la API)

| Subgrupo de la muestra | Reportes | Acierto global | Acierto en campos llenos | Errores | No leidos | Dudosos |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| Legibilidad `buena` | 13 | `376 / 403` (`93.30%`) | `113 / 138` (`81.88%`) | 21 | 4 | 2 |
| Legibilidad `regular` | 5 | `137 / 155` (`88.39%`) | `48 / 59` (`81.36%`) | 12 | 0 | 6 |
| Legibilidad `mala` | 2 | `47 / 62` (`75.81%`) | `9 / 17` (`52.94%`) | 7 | 0 | 8 |
| Diseno `post-000700` | 11 | `318 / 341` (`93.26%`) | `89 / 110` (`80.91%`) | 15 | 4 | 4 |
| Diseno `pre-000700` | 7 | `186 / 217` (`85.71%`) | `61 / 79` (`77.22%`) | 19 | 0 | 12 |
| Diseno `otro` | 2 | `56 / 62` (`90.32%`) | `20 / 25` (`80.00%`) | 6 | 0 | 0 |

---

## 4. Precision detallada en los 31 campos del formulario

La tabla siguiente reproduce exactamente los contadores por campo emitidos por `scripts/evaluar-muestra.mjs --desde-bd=true` sobre los 20 reportes (los contadores `Llenos` y `Vacios` representan aciertos en esa categoria; `Confianza (A/M/B)` indica cuantos de los 20 casos fueron marcados como `alta`, `media` o `baja`):

| Campo | Acierto | Llenos ok | Vacios ok | Errores | No leidos | Dudosos | Confianza (A/M/B) | Err. conf. alta |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `tecnico` | `70.0%` | 13 | 1 | 3 | 0 | 3 | `17 / 2 / 1` | 3 |
| `empresa` | `60.0%` | 12 | 0 | 3 | 0 | 5 | `19 / 1 / 0` | 3 |
| `fecha` | `75.0%` | 12 | 3 | 5 | 0 | 0 | `17 / 0 / 3` | 5 |
| `telefono` | `100.0%` | 0 | 20 | 0 | 0 | 0 | `20 / 0 / 0` | 0 |
| `direccion` | `55.0%` | 10 | 1 | 8 | 0 | 1 | `16 / 2 / 2` | 7 |
| `contacto` | `80.0%` | 7 | 9 | 3 | 0 | 1 | `20 / 0 / 0` | 3 |
| `equipo` | `60.0%` | 10 | 2 | 7 | 1 | 0 | `18 / 2 / 0` | 5 |
| `motivo` | `85.0%` | 15 | 2 | 1 | 1 | 1 | `17 / 3 / 0` | 0 |
| `estado_del_equipo` | `95.0%` | 2 | 17 | 0 | 1 | 0 | `20 / 0 / 0` | 0 |
| `ultimo_mantenimiento` | `100.0%` | 0 | 20 | 0 | 0 | 0 | `20 / 0 / 0` | 0 |
| `limpieza_equipo` | `100.0%` | 2 | 18 | 0 | 0 | 0 | `20 / 0 / 0` | 0 |
| `cabezales` | `90.0%` | 0 | 18 | 2 | 0 | 0 | `20 / 0 / 0` | 2 |
| `sistema_proteccion` | `100.0%` | 2 | 18 | 0 | 0 | 0 | `20 / 0 / 0` | 0 |
| `tinta` | `100.0%` | 0 | 20 | 0 | 0 | 0 | `20 / 0 / 0` | 0 |
| `revision_linea_ln` | `100.0%` | 0 | 20 | 0 | 0 | 0 | `20 / 0 / 0` | 0 |
| `revision_linea_lt` | `100.0%` | 0 | 20 | 0 | 0 | 0 | `20 / 0 / 0` | 0 |
| `revision_linea_nt` | `100.0%` | 0 | 20 | 0 | 0 | 0 | `20 / 0 / 0` | 0 |
| `operador` | `100.0%` | 0 | 20 | 0 | 0 | 0 | `20 / 0 / 0` | 0 |
| `procedimiento` | `90.0%` | 18 | 0 | 0 | 0 | 2 | `16 / 4 / 0` | 0 |
| `conclusion` | `85.0%` | 10 | 7 | 0 | 1 | 2 | `17 / 3 / 0` | 0 |
| `recomendaciones` | `100.0%` | 14 | 6 | 0 | 0 | 0 | `19 / 1 / 0` | 0 |
| `repuestos_tipo` | `100.0%` | 0 | 20 | 0 | 0 | 0 | `20 / 0 / 0` | 0 |
| `codigo_repuesto` | `95.0%` | 0 | 19 | 1 | 0 | 0 | `20 / 0 / 0` | 1 |
| `repuestos_descripcion` | `90.0%` | 0 | 18 | 2 | 0 | 0 | `20 / 0 / 0` | 2 |
| `repuestos_cantidad` | `100.0%` | 1 | 19 | 0 | 0 | 0 | `20 / 0 / 0` | 0 |
| `hora_llegada` | `90.0%` | 8 | 10 | 2 | 0 | 0 | `10 / 0 / 10` | 2 |
| `hora_salida` | `85.0%` | 13 | 4 | 2 | 0 | 1 | `15 / 1 / 4` | 2 |
| `garantia` | `100.0%` | 0 | 20 | 0 | 0 | 0 | `20 / 0 / 0` | 0 |
| `facturado` | `100.0%` | 0 | 20 | 0 | 0 | 0 | `20 / 0 / 0` | 0 |
| `firma_operador` | `95.0%` | 4 | 15 | 1 | 0 | 0 | `20 / 0 / 0` | 1 |
| `firma_cliente` | `100.0%` | 17 | 3 | 0 | 0 | 0 | `20 / 0 / 0` | 0 |
| **Total (620 evaluaciones)** | **`90.32%`** | **170** | **390** | **40** | **4** | **16** | **`581 / 19 / 20`** | **36** |

Observaciones clave por grupos de campos:

- Los 15 campos con `100.0%` de acierto (`300 / 300` evaluaciones en conjunto) abarcan tanto casilleros mayoritariamente vacios en papel como campos diligenciados con alta regularidad (`recomendaciones` con `14` aciertos en llenos y `firma_cliente` con `17` aciertos en llenos).
- Los errores se concentran fuertemente en los campos manuscritos de cabecera e identificacion tecnica: `direccion` (`55.0%`, `8` errores y `7` con confianza alta), `equipo` (`60.0%`, `7` errores y `1` no leido), `empresa` (`60.0%`, `3` errores y `5` dudosos donde la referencia humana fue ilegible), `tecnico` (`70.0%`, `3` errores y `3` dudosos), `fecha` (`75.0%`, `5` errores), y `contacto` (`80.0%`, `3` errores y `1` dudoso).
- En narrativa tecnica extensa (`motivo`, `procedimiento`, `conclusion`, `recomendaciones`), no se registraron errores (`0`) en `procedimiento` (`90.0%`), `conclusion` (`85.0%`) ni `recomendaciones` (`100.0%`), y apenas `1` error de confianza `media` en `motivo` (`85.0%`).

---

## 5. Resultados desglosados por reporte

La siguiente tabla resume los resultados anonimizados de los 20 reportes evaluados (sin nombres de clientes, tecnicos ni direcciones):

| Talonario | Anio | Legibilidad | Diseno | Pag. | Acierto global | Acierto en llenos | Ref. ilegible | Err. (alta conf.) | NL | Dud. | Costo (USD) | Tiempo (ms) |
| :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `000434` | `sin_fecha` | `regular` | `pre-000700` | 1 | `25/31` (`80.65%`) | `6/9` (`66.67%`) | 3 | `3 (3)` | 0 | 3 | `$0.001316` | `45013` |
| `001465` | `2025` | `buena` | `post-000700` | 1 | `30/31` (`96.77%`) | `7/8` (`87.50%`) | 0 | `1 (1)` | 0 | 0 | `$0.001038` | `9097` |
| `001434` | `2025` | `buena` | `post-000700` | 1 | `30/31` (`96.77%`) | `5/6` (`83.33%`) | 0 | `0 (0)` | 0 | 1 | `$0.000914` | `76322` |
| `001435` | `2025` | `buena` | `post-000700` | 4 | `27/31` (`87.10%`) | `2/6` (`33.33%`) | 0 | `2 (1)` | 1 | 1 | `$0.002819` | `50767` |
| `000432` | `sin_fecha` | `mala` | `pre-000700` | 1 | `24/31` (`77.42%`) | `5/8` (`62.50%`) | 4 | `3 (3)` | 0 | 4 | `$0.001244` | `31139` |
| `001724` | `2025` | `buena` | `post-000700` | 2 | `30/31` (`96.77%`) | `8/9` (`88.89%`) | 0 | `1 (1)` | 0 | 0 | `$0.001752` | `40332` |
| `000260` | `sin_fecha` | `mala` | `pre-000700` | 1 | `23/31` (`74.19%`) | `4/9` (`44.44%`) | 3 | `4 (2)` | 0 | 4 | `$0.001261` | `10365` |
| `001534` | `2025` | `buena` | `post-000700` | 2 | `29/31` (`93.55%`) | `10/12` (`83.33%`) | 0 | `2 (2)` | 0 | 0 | `$0.001695` | `27371` |
| `001539` | `2025` | `regular` | `post-000700` | 1 | `27/31` (`87.10%`) | `6/8` (`75.00%`) | 2 | `2 (2)` | 0 | 2 | `$0.000996` | `56339` |
| `001563` | `2025` | `buena` | `post-000700` | 5 | `28/31` (`90.32%`) | `10/13` (`76.92%`) | 0 | `1 (1)` | 2 | 0 | `$0.004275` | `60773` |
| `000266` | `2026` | `regular` | `pre-000700` | 1 | `30/31` (`96.77%`) | `9/10` (`90.00%`) | 0 | `1 (1)` | 0 | 0 | `$0.001190` | `12917` |
| `001997` | `2026` | `buena` | `post-000700` | 3 | `31/31` (`100.00%`) | `13/13` (`100.00%`) | 0 | `0 (0)` | 0 | 0 | `$0.003132` | `176951` |
| `001231` | `2025` | `buena` | `post-000700` | 2 | `31/31` (`100.00%`) | `12/12` (`100.00%`) | 0 | `0 (0)` | 0 | 0 | `$0.002142` | `11160` |
| `001373` | `2025` | `buena` | `post-000700` | 4 | `25/31` (`80.65%`) | `5/11` (`45.45%`) | 0 | `6 (6)` | 0 | 0 | `$0.003066` | `263609` |
| `000035` | `2026` | `buena` | `pre-000700` | 4 | `29/31` (`93.55%`) | `10/11` (`90.91%`) | 0 | `2 (2)` | 0 | 0 | `$0.004853` | `34131` |
| `001733` | `2025` | `buena` | `post-000700` | 3 | `30/31` (`96.77%`) | `11/12` (`91.67%`) | 0 | `0 (0)` | 1 | 0 | `$0.003622` | `73856` |
| `000545` | `2026` | `buena` | `otro` | 1 | `26/31` (`83.87%`) | `7/12` (`58.33%`) | 0 | `5 (5)` | 0 | 0 | `$0.000992` | `4878` |
| `000467` | `2026` | `buena` | `otro` | 1 | `30/31` (`96.77%`) | `13/13` (`100.00%`) | 0 | `1 (1)` | 0 | 0 | `$0.001084` | `93405` |
| `000596` | `2024` | `regular` | `pre-000700` | 1 | `29/31` (`93.55%`) | `13/14` (`92.86%`) | 1 | `1 (1)` | 0 | 1 | `$0.000940` | `15024` |
| `000897` | `2024` | `regular` | `pre-000700` | 1 | `26/31` (`83.87%`) | `14/18` (`77.78%`) | 0 | `5 (4)` | 0 | 0 | `$0.001011` | `5874` |

En la base de datos de produccion al momento de la medicion, `11` reportes figuraban en `pendiente_revision`, `8` en `aprobado_rptech` y `1` en `aprobado`, con `3` correcciones y `3` omisiones humanas registradas previamente en `campos_extraidos` (concentradas en `000545` y `000897`).

---

## 6. Confianza del modelo frente a acierto y carga de revision humana

### 6.1 Calibracion por nivel de confianza

| Confianza declarada | Total campos | Aciertos totales | Desglose aciertos (llenos / vacios) | Errores | No leidos | Dudosos |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `alta` | 581 | `533` (`91.74%`) | `162` llenos / `371` vacios | 36 | 4 | 8 |
| `media` | 19 | `8` (`42.11%`) | `8` llenos / `0` vacios | 3 | 0 | 8 |
| `baja` | 20 | `19` (`95.00%`) | `0` llenos / `19` vacios | 1 | 0 | 0 |
| **Total** | **620** | **`560` (`90.32%`)** | **`170` llenos / `390` vacios** | **40** | **4** | **16** |

Tres hallazgos sobresalen en la calibracion:

1. **Los errores silenciosos con confianza `alta` son el riesgo principal:** de los `40` errores detectados, `36` tuvieron confianza `alta` (`5.81%` sobre los 620 campos y `6.20%` dentro de los `581` de confianza alta). Al no marcarse como `dudoso`, `confianza = 'baja'` ni `noLeido`, estos casos no activan por si solos la regla de bandeja `campoRequiereRevision`.
2. **La confianza `media` senala ambiguedad real pero tampoco entra automaticamente a la bandeja por si sola:** solo `8 / 19` (`42.11%`) resultaron aciertos; los otros `11` fueron `3` errores y `8` dudosos (`5` sobre trazos `ilegible` y `3` diferencias en texto libre).
3. **La confianza `baja` aparece casi exclusivamente en casilleros vacios de hora, fecha o direccion:** `19 / 20` (`95.00%`) fueron campos vacios donde el modelo devolvio correctamente `null` (`10` en `hora_llegada`, `4` en `hora_salida`, `3` en `fecha`, `2` en `direccion` y `1` en `tecnico`, con `1` error en `direccion` de `001435`).

### 6.2 Carga operativa de la bandeja de revision

De acuerdo con la regla vigente `campoRequiereRevision` (`dudoso || confianza === 'baja' || noLeido`):

- En promedio llegan **`5.2%` de los campos por reporte** a la bandeja de revision (`32 / 620`, es decir `5.16%`), distribuidos en `13` de los `20` reportes.
- El peor caso observado fue **`000434` con `6 / 31` campos**, seguido por `001465` (`4 / 31`), y `000432`, `001434`, `001435` (`3 / 31` cada uno).

---

## 7. Tipologia anonimizada de discrepancias y comportamiento de `compararCampo`

Las `60` discrepancias totales (`9.68%` de los 620 campos) se agrupan exactamente en las siguientes categorias anonimizadas:

| Resultado | Categoria anonimizada | Cantidad | Descripcion operativa |
| :--- | :--- | :---: | :--- |
| `error` | Texto manuscrito distinto | 28 | Diferencia frente a transcripcion humana en campos estructurados o cortos (`direccion`, `equipo`, `tecnico`, `empresa`, `contacto`, `cabezales`, `repuestos_descripcion`, `motivo`). |
| `dudoso` | Referencia `ilegible` con propuesta de la IA | 13 | Trazos marcados como `ilegible` por humano (`tecnico`, `empresa`, `motivo`, `conclusion`, `contacto`, `direccion`, `hora_salida`) donde el modelo arriesgo un texto (8 con confianza `alta`, 5 con confianza `media`). |
| `error` | Fecha: mes o anio distinto | 4 | Discrepancia numerica en dia/mes/anio en `fecha` manuscrita (`001435`, `001563`, `001373`, `000545`). |
| `no leído` | Campo lleno marcado `no leído` por la IA | 4 | El papel tenia contenido legible pero el modelo marco `noLeido` con confianza `alta` (`motivo` en `001435`, `equipo` y `conclusion` en `001563`, `estado_del_equipo` en `001733`). Entra automaticamente a la bandeja. |
| `dudoso` | Texto libre con similitud intermedia (`0.50–0.82`) | 3 | Variaciones de lectura sin perdida grave de sentido en `procedimiento` (`001434` similitud `0.74`, `001435` similitud `0.65`) y `conclusion` (`000260` similitud `0.78`). |
| `error` | Casillero vacio en papel donde la IA leyo texto | 3 | Falsos positivos en `direccion` (`000035`), `firma_operador` (`000467`) y `codigo_repuesto` (`000897`), todos sobre `393` campos vacios (`99.24%` de acierto en vacios). |
| `error` | Hora con formato 12h vs 24h | 2 | Discrepancia de exactamente 12 horas en `hora_llegada` y `hora_salida` del reporte `000545` (`otro` diseno sin marca AM/PM). |
| `error` | Hora con lectura distinta | 2 | Diferencia de lectura de digitos manuscritos en `hora_salida` (`000260`) y `hora_llegada` (`001534`). |
| `error` | Fecha parcial humana frente a fecha completa IA | 1 | En `001465`, el dia no era concluyente en lectura humana a ciegas (`AAAA-MM`) y el modelo propuso `AAAA-MM-DD`. |

Impacto del criterio estricto de `compararCampo` (`src/ia-extractor/normalizacion.ts`):

- En los cuatro campos de texto libre (`motivo`, `procedimiento`, `conclusion`, `recomendaciones`), `compararCampo` aplica similitud por bigramas de Dice (`>= 0.82` -> `correcto`, `0.50–0.81` -> `dudoso`).
- En los campos de identificacion corta (`direccion`, `equipo`, `empresa`, `tecnico`, `contacto`, `repuestos_descripcion`), exige igualdad exacta tras normalizacion. Como resultado, exactamente `12` de los `28` errores de texto manuscrito corresponden a diferencias de 1 o 2 caracteres con similitud Dice entre `0.80` y `0.97` (concentrados notablemente en `001373`, donde `tecnico` tuvo similitud `0.92`, `empresa` `0.96`, `direccion` `0.97` y `repuestos_descripcion` `0.94`), mientras que en formularios antiguos muy degradados (`000434`, `000432`, `000260`) si ocurren lecturas divergentes con similitud `0.00–0.59`.

---

## 8. Conclusiones y recomendaciones para produccion

1. **Viabilidad tecnica y de costos confirmada:** mantener `IA_PROVIDER=gemini`, modelo `gemini-3.5-flash-lite` e `IA_LADO_LARGO_PX=1600` resulta ampliamente rentable a `$0.001967 USD` por reporte (`$0.000984 USD` por pagina) y logra `99.24%` en deteccion de casilleros vacios y alto desempeno en listas de verificacion, firmas y narrativa tecnica extensa.
2. **Expectativa realista de precision en mano alzada:** la tasa real medida sin sesgo de confirmacion es `90.32%` global sobre todos los campos (`92.26%` excluyendo casilleros humanamente `ilegible`) y `79.44%` sobre los `214` campos manuscritos llenos, cifra que debe tomarse como linea base oficial en reemplazo del `99.74%` preliminar del Sprint 2.
3. **Justificacion empirica del flujo de revision y doble revision (Sprint 4):** el hallazgo de `36` errores silenciosos con confianza `alta` (`5.81%` del total de campos), mayormente en `direccion`, `equipo`, `fecha`, `empresa`, `tecnico` y `contacto`, valida directamente la necesidad de conservar la cola de revision humana (`SIREP-S4-T02` a `T04`) y el muestreo de **doble revision aleatoria del `5%`** (`SIREP-S4-T08`) antes o despues del envio a RP-TECH.
4. **Acciones de mejora inmediatas en reglas de revision:**
   - Evaluar la inclusion de `confianza === 'media'` en `campoRequiereRevision`, dado que en esta muestra solo acerto en `8 / 19` campos (`42.11%`) y agregaria apenas `19` campos mas en 20 reportes.
   - Revisar en la bandeja las reglas de normalizacion horaria (`12h` vs `24h`) cuando el talonario no explicita `AM/PM`, y reforzar la verificacion visual de `direccion`, `equipo`, `fecha` y `empresa` antes de aprobar envios a RP-TECH.
