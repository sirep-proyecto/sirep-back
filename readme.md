# 📑 SIREP: Backend de Digitalización de Reportes Técnicos

Sistema para digitalizar reportes de servicio técnico industrial escritos a mano archivados en papel, mediante escaneos enviados por **Telegram** y leídos con **Modelos de IA Multimodales intercambiables (Gemini / OpenAI)**, integrados directamente con el histórico de **RP-TECH**.

---

## 🎯 Objetivo y Flujo de Trabajo
1. **Escaneo y Envío:** La secretaria escanea el reporte técnico a 300 dpi (anverso/reverso) y envía el archivo (PDF o foto) al bot de Telegram.
2. **Detección de Duplicados en 2 Etapas:**
   - **Por Huella SHA-256:** Evita registrar el mismo archivo si fue reenviado.
   - **Por N° de Reporte Impreso:** Evita registrar dos veces el mismo reporte físico aunque se escanee dos veces.
3. **Almacenamiento del Original:** El escaneo original se guarda **intacto sin comprimir** en Supabase Storage como documento legal de auditoría.
4. **Extracción Multimodal con IA:** La pieza de IA (Gemini u OpenAI) extrae los campos clave (`cliente`, `fecha`, `serie_equipo`, `procedimiento`, `codigo_repuesto`, `tecnico_asignado`) evaluando confianza (`alta`, `media`, `baja`) y marcando campos ilegibles como `noLeido: true`.
5. **Bandeja de Revisión:** Si algún campo tiene baja confianza o es dudoso, el reporte queda en estado `en_revision` para que un técnico confirme los datos con el recorte de la imagen al lado.

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

### 4. Configurar el Webhook de Telegram
Configura tu webhook con `secret_token` para validación segura:
```bash
curl -F "url=https://<TU_DOMINIO_O_NGROK>/telegram/webhook" \
     -F "secret_token=<TU_TELEGRAM_WEBHOOK_SECRET>" \
     https://api.telegram.org/bot<TU_TELEGRAM_BOT_TOKEN>/setWebhook
```

### 5. Iniciar el Servidor de Desarrollo
```bash
npm run start:dev
```
El servidor estará corriendo en:
- API Base: `http://localhost:3000`
- Documentación Swagger: `http://localhost:3000/docs`
- Health check: `http://localhost:3000/health`

---

## 🧪 Pruebas Unitarias
El proyecto cuenta con suites de pruebas unitarias completas con mocks (sin costo de API):

```bash
# Ejecutar todas las pruebas de SIREP
npm test

# Ejecutar únicamente la pieza de IA intercambiable (Backend 1)
npx jest src/ia-extractor/ia-extractor.spec.ts

# Ejecutar las pruebas de escaneos y bot de Telegram (Backend 2)
npx jest src/escaneos/escaneos.service.spec.ts src/telegram/telegram-sirep.spec.ts
```

---

## 🔄 Selección del Proveedor de IA
La pieza de IA es intercambiable y se selecciona mediante la variable de entorno `IA_PROVIDER`:
- `IA_PROVIDER=gemini` (usa Google Gemini 2.5 Flash / 1.5 Flash).
- `IA_PROVIDER=openai` (usa GPT-4o-mini / GPT-4o).

Ambos proveedores registran automáticamente:
- `tokensEntrada` y `tokensSalida`.
- `costoEstimadoUSD` por reporte para presupuestar la digitalización de los 400 a 500 reportes.
