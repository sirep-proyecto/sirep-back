# Contrato de importación del histórico SIREP → RP-TECH

**Versión:** 1 (borrador para revisar con Miguel Quijano). Revisado contra el código de `sirep-back` del 16/11.
**Estado:** el lado de RP-TECH ya está hecho (migración `20261116100000_historico.sql` y función `importar-historico`), con el talonario opcional (sección 9, opción a).
**Va en:** `docs/contrato-historico.md`, igual en los dos repos.
**Aprueba:** el coordinador del proyecto. Cualquier cambio sube la versión.

Este contrato lo fija RP-TECH, que es donde viven los datos, y SIREP adapta su salida. Está hecho a partir de las tablas actuales de SIREP (`escaneos` y `reportes`).

---

## 1. Qué se envía y cuándo

- Solo se envían los reportes de SIREP con `origen = 'historico'`, `estado_reporte = 'aprobado'` y ningún campo en `estado_revision = 'pendiente'`. Es decir, los revisados en la bandeja.
- **El valor que se envía de cada campo es el vigente** (`valorVigente` de `reportes.mapper.ts`): primero la corrección humana, luego lo leído por la IA, y vacío si el campo quedó `ilegible` u `omitido` (vacío en el papel, decidido siempre por una persona).
- Se envía **un reporte por petición**, junto con su escaneo.
- Cuando RP-TECH responde `creado` o `ya_existia`, SIREP marca el reporte como `aprobado_rptech` y guarda `importado_en`. Si responde con error, el reporte queda en `aprobado` para corregirlo y reenviarlo.

## 2. Cómo se llama

| | |
|---|---|
| Método y ruta | `POST https://<proyecto>.supabase.co/functions/v1/importar-historico` |
| Autenticación | Cabecera `x-sirep-clave: <clave propia de SIREP>` |
| Formato | `Content-Type: application/json` |
| Tamaño máximo | 10 MB por petición, con el escaneo incluido |

- **La clave de SIREP es propia.** No es la clave de servicio de RP-TECH ni la de SIREP, y hay una distinta en pruebas y en producción.
- **RP-TECH decide la empresa a partir de la clave.** El `empresa_id` que tiene SIREP no se envía, porque hoy vale `00000000-…` por defecto.

## 3. Correspondencia de campos

### Identificación

| SIREP | Contrato (RP-TECH) | Regla |
|---|---|---|
| `reportes.id` | `sirep_id` | Obligatorio. Si llega dos veces, se devuelve el reporte ya guardado sin duplicarlo |
| `reportes.numero_talonario` | `numero_talonario` | Obligatorio, único por empresa. Si llega un `sirep_id` nuevo con un talonario ya cargado, se rechaza |
| `reportes.fecha` | `fecha` | `AAAA-MM-DD` |

### Datos leídos (se guardan como texto, tal cual)

| SIREP | Contrato |
|---|---|
| `cliente` | `cliente_texto` |
| `serie_equipo` | `equipo_texto` |
| `tecnico_asignado` | `tecnico_texto` |
| `direccion` | `direccion_texto` |
| `contacto` | `contacto_texto` |
| `telefono` | `telefono_texto` |
| `motivo` | `motivo` |

**Los vínculos no se envían.** Los campos `cliente_id`, `equipo_id` y `tecnico_perfil_id` de SIREP apuntan a las tablas `clientes`, `equipos` y `perfiles` **de SIREP**, no a las de RP-TECH. Por eso no sirven como vínculo.
- El vínculo se sugiere con la búsqueda por similitud de RP-TECH, que es la tarea T05.
- Lo confirma el coordinador en la pantalla Histórico.

### Revisión inicial (mismos nombres y valores que `reportes` de RP-TECH)

| SIREP | Contrato | Valores permitidos |
|---|---|---|
| `estado_equipo` | `estado_equipo` | `operativo`, `inoperativo` |
| `ultimo_mantenimiento` | `ultimo_mantenimiento` | `AAAA-MM-DD` |
| `limpieza_equipo` | `limpieza` | `limpio`, `sucio` |
| `cabezales` | `estado_cabezales` | `bueno`, `regular`, `malo` |
| `sistema_proteccion` | `sistema_proteccion` | `estabilizador`, `ups`, `otro` |
| (no existe) | `sistema_proteccion_otro` | Texto, si `sistema_proteccion = otro` |
| `tinta` | `tinta` | Texto |
| `revision_linea_ln` | `voltaje_ln` | Número de 0 a 1000 |
| `revision_linea_lt` | `voltaje_lt` | Número de 0 a 1000 |
| `revision_linea_nt` | `voltaje_nt` | Número de 0 a 1000 |
| `operador` | `operador` | Texto |

**Cómo convierte SIREP sus valores** (el formulario de `campos-formulario.ts` ya los tiene casi listos):

| Campo en SIREP | Valor en SIREP | Valor en el contrato |
|---|---|---|
| `estado_del_equipo` | Operativo / Inoperativo | `operativo` / `inoperativo` |
| `limpieza_equipo` | Limpio / Sucio | `limpio` / `sucio` |
| `cabezales` | Bueno / Regular / Malo | `bueno` / `regular` / `malo` |
| `sistema_proteccion` | Texto libre («Estab.», «UPS», etc.) | Si dice «estab…»: `estabilizador`; si dice «UPS»: `ups`; si dice otra cosa: `otro`, con el texto en `sistema_proteccion_otro`; si está vacío: vacío |
| `ultimo_mantenimiento` | Texto (fecha u observación) | Si es una fecha: `AAAA-MM-DD`; si no, vacío y el texto en `datos_originales.ultimo_mantenimiento` |
| `revision_linea_*` | Texto («220», «220V», «220 v») | El número (220); si no se puede leer un número, vacío y el texto en `datos_originales` |

### Labor

| SIREP | Contrato | Formato |
|---|---|---|
| `procedimiento` | `procedimiento` | Texto |
| `conclusion` | `conclusion` | Texto |
| `recomendaciones` | `recomendaciones` | Texto |
| (no está en el formulario físico) | `resultado` | Va vacío |
| (no está en el formulario físico) | `requerimiento` | Va vacío |
| `hora_llegada` | `hora_llegada` | `HH:MM`; SIREP ya lo normaliza con `normalizarHoraEvaluacion` |
| `hora_salida` | `hora_salida` | `HH:MM` |
| (no existe) | `horas` | Número decimal. Si no viene, RP-TECH lo calcula con la llegada y la salida |

### Repuestos

En SIREP son cuatro textos: `repuestos_tipo` es **una sola casilla** para toda la tabla (Venta, Descarte o Garantía), y `codigo_repuesto`, `repuestos_descripcion` y `repuestos_cantidad` tienen **una línea por fila** de la tabla. En el contrato son **una lista**, con un elemento por repuesto:

| Campo | Formato |
|---|---|
| `codigo` | Texto o vacío |
| `descripcion` | Texto |
| `cantidad` | Número mayor que 0 |
| `tipo` | `venta`, `descarte` o `garantia` |

SIREP arma la lista así:
- separa las tres columnas por línea, y la línea N de cada columna forma el repuesto N;
- el `tipo` es la casilla marcada, igual para todos: Venta → `venta`, Descarte → `descarte`, Garantía → `garantia`;
- si las columnas no tienen la misma cantidad de líneas, o una cantidad no es un número, manda la lista vacía y los cuatro textos en `datos_originales`.

### Otros

| SIREP | Contrato | Valores |
|---|---|---|
| `garantia` (casilla) | `garantia` | Marcada: `si`; no marcada: `no`; omitida (`omitido`): `no`; ilegible o sin revisar: `sin_dato` |
| `facturado` (casilla) | `facturado` | Igual que `garantia` |
| `firma_operador` | `firma_operador_presente` | `true` o `false` |
| `firma_cliente` | `firma_cliente_presente` | `true` o `false` |
| `campos_extraidos` (por campo: `confianza` y `estado_revision`) | `revision_campos` | Objeto con una entrada por campo, con el nombre **del contrato**: `{ "confianza": "alta" \| "media" \| "baja", "estado": "auto" \| "confirmado" \| "corregido" \| "ilegible" \| "omitido" }` |
| `corregido_por` | `revisado_por` | Nombre de quien lo revisó en la bandeja |
| `fecha_correccion` | `revisado_en` | Fecha y hora ISO 8601 con zona |
| `campos_extraidos` y lo que no encaje | `datos_originales` | Objeto JSON con todo lo leído que no tiene columna |

`revision_campos` es la «confianza por campo» del documento del sprint. SIREP ya la guarda en `campos_extraidos`. La pantalla Histórico marca los campos con confianza `baja` o con estado `ilegible`.

### Escaneo

| SIREP | Contrato |
|---|---|
| El archivo de `escaneos.ruta_original` | `escaneo.contenido_base64` |
| El tipo del archivo original | `escaneo.tipo`: `application/pdf`, `image/jpeg` o `image/png` (por Telegram también llegan fotos) |
| `escaneos.huella` | `escaneo.sha256`: ya es el SHA-256 del archivo original (`calcularHuellaSHA256`), en hexadecimal y minúsculas |
| `escaneos.paginas` | `escaneo.paginas` |
| `escaneos.numero_reporte` | Se ignora; manda `numero_talonario` |

- RP-TECH vuelve a calcular el SHA-256. Si no coincide con el enviado, rechaza el reporte.
- RP-TECH revisa también los primeros bytes del archivo: un `tipo` que no coincide con el contenido se rechaza.
- Guarda el archivo en el bucket privado `historicos`.

### Lo que no se envía

| Campo de SIREP | Motivo |
|---|---|
| `cliente_id`, `equipo_id`, `tecnico_perfil_id` | Apuntan a las tablas propias de SIREP, no a las de RP-TECH |
| `telegram_chat_id`, `enviado_por` | Son datos de la persona que envió la foto, y RP-TECH no los necesita |
| `fotos_ingreso`, `fotos_salida`, `firmas_digitales_pad`, `numero_caso_crm`, `bloqueado` | Son para reportes con `origen = sistema`, que no forman parte de este contrato |

## 4. Valores que no encajan

- Si un valor leído no está en la lista permitida (por ejemplo, `estado_equipo = "funciona"`), el campo va **vacío** y el texto leído va en `datos_originales`, con la misma clave.
- **SIREP no inventa valores:** ante la duda, deja el campo vacío.
- **Formatos que se aceptan:** fechas `AAAA-MM-DD`, horas `HH:MM` y voltajes y horas como número, no como texto. Un formato distinto se rechaza con el motivo por campo.

## 5. Ejemplo de envío

```json
{
  "version": 1,
  "sirep_id": "3f6c1e2a-9b7d-4c1e-8a5f-2d4b6c8e0f12",
  "numero_talonario": "004512",
  "fecha": "2025-08-14",
  "cliente_texto": "Textiles Andinos SAC",
  "equipo_texto": "Epson F9470 S/N X5ZT001234",
  "tecnico_texto": "J. Quispe",
  "direccion_texto": "Av. Argentina 1234, Lima",
  "contacto_texto": "Rosa Pérez",
  "telefono_texto": "987654321",
  "motivo": "Imprime con líneas blancas",
  "estado_equipo": "inoperativo",
  "ultimo_mantenimiento": "2025-05-02",
  "limpieza": "sucio",
  "estado_cabezales": "regular",
  "sistema_proteccion": "estabilizador",
  "sistema_proteccion_otro": null,
  "tinta": "Original Epson",
  "voltaje_ln": 220,
  "voltaje_lt": 221,
  "voltaje_nt": 1.5,
  "operador": "Jorge Candia",
  "procedimiento": "Limpieza de cabezal y cambio de damper dañado",
  "conclusion": "Damper dañado generaba falta de inyección",
  "recomendaciones": "Limpieza semanal",
  "resultado": "resuelto",
  "requerimiento": null,
  "hora_llegada": "10:05",
  "hora_salida": "12:40",
  "horas": 2.58,
  "repuestos": [
    { "codigo": "DMP-F9", "descripcion": "Damper F9470", "cantidad": 1, "tipo": "venta" }
  ],
  "garantia": "no",
  "facturado": "si",
  "firma_operador_presente": true,
  "firma_cliente_presente": true,
  "revision_campos": {
    "voltaje_nt": { "confianza": "baja", "estado": "corregido" },
    "ultimo_mantenimiento": { "confianza": "media", "estado": "confirmado" }
  },
  "revisado_por": "Miguel Quijano",
  "revisado_en": "2026-11-16T10:30:00-05:00",
  "datos_originales": { "tinta_leida": "orig. epson" },
  "escaneo": {
    "tipo": "application/pdf",
    "sha256": "9f2b…c41a",
    "paginas": 1,
    "contenido_base64": "JVBERi0xLjcK…"
  }
}
```

## 6. Respuestas

| Estado HTTP | Cuerpo | Qué hace SIREP |
|---|---|---|
| `201` | `{ "id": "<uuid en RP-TECH>", "resultado": "creado" }` | Marca `aprobado_rptech` |
| `200` | `{ "id": "<uuid en RP-TECH>", "resultado": "ya_existia" }` | Marca `aprobado_rptech` (es un reenvío) |
| `401` | `{ "codigo": "clave_invalida" }` | Revisa la clave; no reintenta |
| `409` | `{ "codigo": "talonario_duplicado", "motivo": "El talonario 004512 ya está cargado con otro sirep_id" }` | Lo marca `observado` para revisarlo |
| `422` | `{ "codigo": "datos_invalidos", "campos": { "voltaje_ln": "debe ser un número entre 0 y 1000", "fecha": "formato AAAA-MM-DD" } }` | Lo marca `observado` con el motivo por campo |
| `413` | `{ "codigo": "escaneo_muy_grande" }` | Comprime el PDF y reenvía |
| `405` | `{ "codigo": "metodo_no_permitido" }` | Usa `POST` |
| `500` | `{ "codigo": "error_interno" }` | Reintenta más tarde |

## 7. Estado en RP-TECH

- Si una petición pasa de 10 MB, RP-TECH responde `413` sin leerla entera; según el cliente HTTP, SIREP puede ver el `413` o la conexión cerrada. Las dos cosas significan lo mismo.

- El reporte entra **cerrado** y nadie lo modifica desde la aplicación.
- Después solo se completa el vínculo de cliente, equipo, técnico o sede, que confirma el coordinador.

## 8. Lo que tiene que cambiar en SIREP

Sale de la revisión del código de `sirep-back` del 16/11.

1. **No marcar `aprobado_rptech` sin enviar.**
   - Hoy `scripts/migrar-revisados-rptech.mjs` pone `aprobado_rptech`, `bloqueado = true` e `importado_en` **sin enviar nada a RP-TECH**.
   - Ese estado solo se pone cuando RP-TECH responde `creado` o `ya_existia`. Hay que cambiar el script para que llame a `importar-historico`, o no usarlo.
2. **Hacer el envío.** Hoy SIREP no tiene ninguna llamada a RP-TECH. Falta:
   - el módulo que arma el JSON de este contrato y llama a `importar-historico` con `x-sirep-clave`;
   - las variables `RPTECH_URL` y `RPTECH_CLAVE` en `.env.example`, sin valores.
3. **Vínculos.**
   - SIREP creó sus propias tablas `clientes`, `equipos` y `perfiles`, y vincula por similitud (0,85) con ellas.
   - Esos ids no sirven en RP-TECH, y esas tablas repiten datos que ya viven en RP-TECH.
   - **El vínculo oficial lo hace RP-TECH:** lo sugiere su búsqueda (T05) y lo confirma el coordinador.
   - SIREP puede seguir usando sus tablas para ayudar a la lectura, pero no envía esos ids.
4. **Convertir los valores** según las tablas de la sección 3: las opciones a minúsculas, el sistema de protección, los voltajes a número, la última fecha de mantenimiento, los repuestos como lista y las casillas a `si` o `no`.
5. **La empresa.** El `empresa_id` por defecto (`00000000-…`) no se envía. RP-TECH asigna la empresa a partir de la clave.

## 9. Para decidir antes de aprobar

1. **Reportes sin N° de talonario.** En SIREP puede venir vacío; hoy muestra `SN-xxxxxxxx`. Hay dos opciones:
   - **(a) recomendada:** se aceptan sin talonario, identificados solo por `sirep_id`, y la unicidad del talonario se aplica cuando viene;
   - **(b):** se rechazan hasta que alguien escriba el talonario en la bandeja.
   - Decide el coordinador.
2. **Tamaño.** El PDF tiene como máximo 4 páginas (`MAX_PAGINAS_REPORTE`). Miguel debe confirmar que un escaneo típico pesa menos de 7 MB, porque en base64 crece un 33 % y el límite es de 10 MB. Si pesa más, se cambia a dos pasos: primero subir el archivo y luego enviar los datos.
3. **Equipo.** En el formulario físico, «equipo» es el modelo y la marca, no la serie: `serie_equipo` guarda ese texto. La búsqueda de T05 debe buscar por modelo y marca además de por serie.
