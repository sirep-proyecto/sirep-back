# 📑 SIREP: Backend de Digitalización de Reportes Técnicos

Sistema para digitalizar reportes de servicio técnico industrial escritos a mano archivados en papel, mediante escaneos enviados por **Telegram** y leídos con **Modelos de IA Multimodales intercambiables (Gemini / OpenAI)**, integrados directamente con el histórico de **RP-TECH**.

---

## 🎯 Objetivo y Flujo de Trabajo
1. **Escaneo y Envío:** La secretaria escanea el reporte técnico a 300 dpi (anverso/reverso) y envía el archivo (PDF o foto) al bot de Telegram.
2. **Detección de Duplicados en 2 Etapas:**
   - **Por Huella SHA-256:** Evita registrar el mismo archivo si fue reenviado.
   - **Por N° de Reporte Impreso:** Evita registrar dos veces el mismo reporte físico aunque se escanee dos veces.
3. **Almacenamiento del Original:** El escaneo original se guarda **intacto sin comprimir** en Supabase Storage como documento legal de auditoría.
4. **Una imagen por página:** Si llega un PDF, cada página se convierte a imagen PNG (`PDF_DPI`, 200 por defecto) y se guarda junto al original. Un PDF debe traer un solo reporte (anverso y reverso, máximo `MAX_PAGINAS_REPORTE`).
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
| `PATCH` | `/reportes/:numero/campos/:campoId` | `{ "tipo": "confirmar" \| "corregir" \| "ilegible" \| "reabrir", "actor": "...", "valor": "..." }` |

- Lo que leyó el modelo **nunca se sobrescribe**: la corrección se guarda aparte (`campos_extraidos.<campo>.revision`) con quién y cuándo.
- Las columnas de `reportes` (cliente, fecha, equipo…) se actualizan con el valor vigente al corregir.
- Si dos personas corrigen a la vez, la segunda recibe un `409` y no pisa el trabajo de la primera.
- Los reportes sin N° legible se abren con `SN-` + los 8 primeros caracteres de su id.

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
- `IA_PROVIDER=gemini` (usa Google Gemini 2.5 Flash / 1.5 Flash).
- `IA_PROVIDER=openai` (usa GPT-4o-mini / GPT-4o).

Ambos proveedores registran automáticamente:
- `tokensEntrada` y `tokensSalida`.
- `costoEstimadoUSD` por reporte para presupuestar la digitalización de los 400 a 500 reportes.
