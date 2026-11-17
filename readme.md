# 📑 SIREP: Backend de Digitalización de Reportes Técnicos

Sistema para digitalizar reportes de servicio técnico industrial escritos a mano archivados en papel, mediante escaneos enviados por **Telegram** y leídos con **Modelos de IA Multimodales intercambiables (Gemini / OpenAI)**, integrados directamente con el histórico de **RP-TECH**.

---

## 🎯 Objetivo y Flujo de Trabajo
1. **Escaneo y Envío:** La secretaria escanea el reporte técnico a 300 dpi (anverso/reverso) y envía el archivo (PDF o foto) al bot de Telegram.
2. **Detección de Duplicados en 2 Etapas:**
   - **Por Huella SHA-256:** Evita registrar el mismo archivo si fue reenviado.
   - **Por N° de Reporte Impreso:** Evita registrar dos veces el mismo reporte físico aunque se escanee dos veces.
3. **Almacenamiento del Original:** El escaneo original se guarda **intacto sin comprimir** en Supabase Storage como documento legal de auditoría.
4. **Una imagen por página:** Si llega un PDF, cada página se convierte a imagen PNG (`PDF_DPI`, 200 por defecto) y se guarda junto al original. Un PDF debe traer un solo reporte (máximo `MAX_PAGINAS_REPORTE` páginas, 10 por defecto).
5. **Extracción Multimodal con IA:** La pieza de IA (Gemini u OpenAI) lee cada página como imagen JPEG comprimida (`IA_LADO_LARGO_PX`) y extrae los campos del formulario (`tecnico`, `empresa`, `fecha`, `equipo`, `procedimiento`, `codigo_repuesto`, etc.) con su confianza (`alta`, `media`, `baja`), marcando los ilegibles como `noLeido: true`. Si el modelo falla no se guarda nada y se avisa al chat.
6. **Bandeja de Revisión:** Si algún campo tiene baja confianza o es dudoso, el reporte queda en estado `en_revision` para que un técnico confirme los datos con el recorte de la imagen al lado.

---

## 🏗️ Requisitos Previos
- **Node.js**: v20 o superior (recomendado v22+).
- **npm** o **pnpm**.
- **Supabase CLI** (para desarrollo local con migraciones):
  ```bash
  npm install -g supabase
  ```
- Claves de API:
  - Google Gemini API Key (`GEMINI_API_KEY`).
  - OpenAI API Key (`OPENAI_API_KEY`) opcional, para la prueba de viabilidad comparativa.
  - Bot de Telegram vía `@BotFather` (`TELEGRAM_BOT_TOKEN`).

---

## 🚀 Instalación y Puesta en Marcha

### 1. Clonar e instalar dependencias
```bash
git clone <repo-url> sirep-back
cd sirep-back
npm install
```

### 2. Configurar variables de entorno
Copia la plantilla y edita tus claves:
```bash
cp .env.example .env
```

### 3. Iniciar Supabase en Local y correr Migraciones
Inicia los servicios locales de Supabase (PostgreSQL, Storage y Auth):
```bash
supabase start
```
Para reconstruir la base completa y aplicar todas las migraciones:
```bash
supabase db reset
```

### 4. Iniciar el Servidor de Desarrollo
```bash
npm run start:dev
```
El servidor estará corriendo en:
- API Base: `http://localhost:3000`
- Documentación Swagger: `http://localhost:3000/docs`
- Health check: `http://localhost:3000/health`

### 5. Registrar el Webhook de Telegram
Telegram solo entrega mensajes a una URL pública con **https**. En local abre un túnel en otra terminal
(`ngrok http 3000` o `cloudflared tunnel --url http://localhost:3000`), copia la URL que entrega y ejecútala:
```bash
npm run telegram:webhook -- https://<TU_DOMINIO_O_TUNEL>   # registra el webhook con el secret_token del .env
npm run telegram:webhook -- info                           # muestra la URL registrada y el último error de Telegram
npm run telegram:webhook -- delete                         # lo quita
```
`TELEGRAM_WEBHOOK_SECRET` solo admite letras, números, `_` y `-`. Si cambias de túnel, vuelve a registrar.

### 6. Probar el flujo
Envía al bot un PDF llamado `000845.pdf` (o una foto con el N° en el texto). Debes recibir "Procesando…" y luego el resumen del reporte.
Si no llega nada: `npm run telegram:webhook -- info` muestra el error que ve Telegram, y los logs del servidor muestran el resto.

---
## 🔌 API de reportes (bandeja de revisión)

El frontend (`sirep-front`, puerto 3001) consume estos endpoints. Los datos son los que llegaron por Telegram:

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/reportes` | Lista los reportes digitalizados con sus campos y estado. |
| `GET` | `/reportes/:numero` | Un reporte con enlaces temporales (1 h) a la imagen de cada página. |
| `PATCH` | `/reportes/:numero/campos/:campoId` | `{ "tipo": "confirmar" \| "corregir" \| "ilegible" \| "omitir" \| "reabrir", "actor": "...", "valor": "..." }` |

### Subir un reporte desde la página web

`POST /escaneos/upload` (requiere `Authorization: Bearer <token>`, `multipart/form-data`). **Un archivo por petición**; para subir varios, la página hace una petición por archivo.

- Campos: `file` (obligatorio; PDF de 1 a `MAX_PAGINAS_REPORTE` páginas, o foto JPG/PNG/WebP, hasta `MAX_MB_ESCANEO` MB, 10 por defecto) y `numeroReporte` (opcional).
- Queda con `enviado_por` = nombre del usuario logueado y sin chat de Telegram; la bandeja lo muestra con `canal: "web"` (los de Telegram, `canal: "telegram"`).
- CORS: se permiten los orígenes de `FRONTEND_URL` (más localhost), con `Authorization` y multipart.

**Éxito (201):**

```json
{ "escaneoId": "…", "numeroReporte": "000845", "estado": "procesado",
  "camposDudosos": ["codigo_repuesto"], "totalPaginas": 2,
  "campos": { }, "huella": "…", "rutasPaginas": ["…"], "metricasIA": { } }
```

`estado` es `procesado` (hay campos por revisar) o `completo`. Si no se detectó N°, `numeroReporte` es `"Sin N° detectado"`.

**Errores:** siempre `{ "statusCode", "codigo", "message" }`, con `message` en español para mostrar tal cual.

| HTTP | `codigo` | Cuándo |
|---|---|---|
| 400 | `formato_no_admitido` | No es PDF ni imagen (Word, etc.) |
| 400 | `demasiadas_paginas` | El PDF excede `MAX_PAGINAS_REPORTE` |
| 400 | `archivo_danado` | PDF dañado o con contraseña, o archivo vacío |
| 400 | `falta_archivo` | No se envió el campo `file` |
| 413 | `muy_grande` | Supera `MAX_MB_ESCANEO` |
| 409 | `archivo_duplicado` / `reporte_duplicado` | Ya existe; trae además `numeroReporte`, `escaneoId`, `recibidoEn`, `origen` (`telegram`/`web`) y `enviadoPor` del existente (`null` si no se conocen) |
| 502 | `lectura_ia` | Falló la IA; no se guardó nada, se puede reintentar |

Ejemplo 409: `{"statusCode":409,"message":"El reporte N° 000845 ya se encuentra registrado.","codigo":"reporte_duplicado","numeroReporte":"000845","escaneoId":"…","recibidoEn":"2026-11-10T15:00:00Z","origen":"telegram","enviadoPor":"telegram"}`

- Lo que leyó el modelo **nunca se sobrescribe**: la corrección se guarda aparte (`campos_extraidos.<campo>.revision`) con quién y cuándo.
- Las columnas de `reportes` (cliente, fecha, equipo…) se actualizan con el valor vigente al corregir.
- Si dos personas corrigen a la vez, la segunda recibe un `409` y no pisa el trabajo de la primera.
- Los reportes sin N° legible se abren con `SN-` + los 8 primeros caracteres de su id.

## 📤 Envío del histórico a RP-TECH

El reporte aprobado vive en RP-TECH. SIREP lo envía a la función `importar-historico` de RP-TECH según el contrato [docs/contrato-historico.md](docs/contrato-historico.md) (versión 1).

- **Configuración:** `RPTECH_URL` y `RPTECH_CLAVE` en `.env` (la clave la entrega RP-TECH por privado). Sin las dos no se envía nada y nada se marca como importado.
- **Cuándo se envía:** solo a mano, desde la bandeja: botón "Enviar" de cada reporte (`PATCH /reportes/:numero/importar`) o "Enviar completados a RP-TECH" (`POST /reportes/importar-lote`). También con `npm run db:migrar-revisados` (`-- --dry-run` para simular). No hay envío automático.
- **Qué se marca:** `aprobado_rptech`, `bloqueado` e `importado_en` solo cuando RP-TECH responde que lo guardó; además se guarda `rptech_id`. Si RP-TECH lo rechaza (talonario repetido o datos que no cumplen el contrato), queda `observado` con el motivo en `rptech_error`. Sin conexión, queda como estaba para reintentar.
- **Qué no se envía:** los ids de las tablas propias de SIREP (`cliente_id`, `equipo_id`, `tecnico_perfil_id`) ni `empresa_id`. El vínculo con los clientes reales lo hace RP-TECH.
- **Código:** `src/rptech/rptech.envio.ts` (conversión al contrato) y `src/rptech/rptech.cliente.ts` (envío y respuesta), con sus pruebas.
- **Reabrir:** un reporte que ya está en RP-TECH no se reabre, porque allá entra cerrado.

## ⚙️ Configuración del bot desde la app

En **Configuración → Bot de Telegram** se ve el bot, a qué dirección le manda Telegram los mensajes, cuántos hay en cola y el último error. Si la dirección pública del backend cambia (otro túnel de ngrok, otro dominio), se escribe la nueva y se toca **Volver a conectar**; **Desconectar** quita el webhook (Telegram guarda los mensajes hasta que se vuelva a conectar). Es lo mismo que `npm run telegram:webhook`, sin entrar al servidor.

- API: `GET /configuracion/bot`, `PUT /configuracion/bot` con `{ "url": "https://..." }` y `DELETE /configuracion/bot`.
- Antes de conectar se comprueba que la dirección escrita **llegue a este mismo backend** (`GET /configuracion/bot/eco/:codigo` con un código de un solo uso). Así nadie puede desviar las fotos de los reportes a otro servidor desde la pantalla.
- Solo https. Los mensajes en cola no se pierden.
- Lo cambian los roles de `BOT_CONFIG_ROLES` (por defecto `admin,operador`); los demás solo lo ven.

## 🧪 Pruebas Unitarias
El proyecto cuenta con suites de pruebas unitarias completas con mocks (sin costo de API):

```bash
# Ejecutar todas las pruebas de SIREP
npm test

# Ejecutar únicamente la pieza de IA intercambiable (Backend 1)
npx jest src/ia-extractor/ia-extractor.spec.ts

# Ejecutar las pruebas de escaneos y bot de Telegram (Backend 2)
npx jest src/escaneos src/telegram
```

---

## 🔄 Selección del Proveedor de IA
La pieza de IA es intercambiable y se selecciona mediante la variable de entorno `IA_PROVIDER`:
- `IA_PROVIDER=gemini` (usa Google Gemini, predeterminado `gemini-3.8-flash` configurable vía `GEMINI_MODEL`).
- `IA_PROVIDER=openai` (usa OpenAI, predeterminado `gpt-4o-mini` configurable vía `OPENAI_MODEL`).

Ambos proveedores registran automáticamente:
- `tokensEntrada` y `tokensSalida`.
- `costoEstimadoUSD` por reporte para presupuestar la digitalización de los 400 a 500 reportes.

---

## 🔬 Script de Evaluación Automatizada de la Muestra (SIREP-S2-T07)

Permite procesar lotes de escaneos manuscritos (PDFs o imágenes) comparándolos campo a campo contra una plantilla transcrita de referencia, sin tocar Supabase ni Telegram:

```bash
# Ejecutar con Gemini (1600 px por defecto)
node scripts/evaluar-muestra.mjs --proveedor=gemini

# Ejecutar con OpenAI especificando modelo y resolución
node scripts/evaluar-muestra.mjs --proveedor=openai --modelo=gpt-4o-mini --lado-largo=1600

# Parámetros disponibles:
#   --proveedor=gemini|openai   Selector de modelo de IA
#   --modelo=nombre_modelo      Modelo específico a evaluar
#   --lado-largo=1600|2400      Resolución máxima en píxeles del lado largo
#   --muestra=./muestra         Carpeta con los archivos PDF / JPG
#   --plantilla=./ref.csv       CSV de transcripción manual de referencia
#   --salida=./resultados.csv   Ruta del reporte CSV generado (UTF-8 con BOM)
```

El script genera:
1. Respuestas crudas en JSON dentro de `./resultados_json/` para auditoría técnica.
2. Archivo CSV con codificación UTF-8 con BOM listo para abrir en Excel con columnas: `reporte`, `campo`, `valor esperado`, `valor leído`, `confianza`, `resultado`, `costo`, `tiempo`.

