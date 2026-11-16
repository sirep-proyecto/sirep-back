# Envío del histórico a RP-TECH y configuración del bot: cómo instalarlo

Este zip trae los archivos de `sirep-back` **en su misma ruta**. Copia todo el contenido del zip encima de la carpeta del repo y acepta reemplazar. Este archivo `LEEME-envio-rptech.md` no hace falta guardarlo en el repo.

## Archivos

| Archivo | Qué es |
|---|---|
| `src/rptech/rptech.envio.ts` | **Nuevo.** Convierte un reporte de SIREP al JSON del contrato |
| `src/rptech/rptech.cliente.ts` | **Nuevo.** Hace el envío a RP-TECH y guarda la respuesta en `reportes` |
| `src/rptech/rptech.service.ts`, `rptech.module.ts` | **Nuevos.** El envío dentro de NestJS |
| `src/rptech/rptech.envio.spec.ts`, `rptech.cliente.spec.ts` | **Nuevos.** Pruebas: 22 casos |
| `src/reportes/reportes.service.ts` | **Cambia.** `importar` e `importar-lote` ahora envían a RP-TECH, en vez de marcar como importado sin enviar. Al terminar de revisar un reporte se envía solo. Un reporte que ya está en RP-TECH no se reabre |
| `src/reportes/reportes.module.ts`, `reportes.mapper.ts` | **Cambian.** Usan el módulo nuevo y agregan `rptech_id` y `rptech_error` |
| `src/reportes/reportes.service.spec.ts` | **Cambia.** Pruebas de importación con RP-TECH simulado |
| `scripts/migrar-revisados-rptech.mjs` | **Cambia.** El lote envía de verdad y solo marca lo que RP-TECH confirma |
| `supabase/migrations/20261116100000_envio_rptech.sql` | **Nuevo.** Agrega `rptech_id`, `rptech_error` y `rptech_enviado_en` a `reportes`. Solo agrega columnas |
| `src/configuracion/*` | **Nuevo.** API para ver el bot, volver a conectarlo a la dirección pública nueva del backend o desconectarlo: `GET`, `PUT` y `DELETE /configuracion/bot`. Con pruebas |
| `src/app.module.ts` | **Cambia.** Registra el módulo de configuración |
| `docs/contrato-historico.md` | **Nuevo.** Contrato v1, igual al de RP-TECH |
| `.env.example`, `readme.md` | **Cambian.** Variables nuevas y la sección «Envío del histórico a RP-TECH» |

## Pasos (CMD, en la carpeta de `sirep-back`)

1. Crea una rama y copia los archivos:
```
git checkout main
git pull
git checkout -b feature/envio-rptech
```
   Copia el contenido del zip encima del repo.

2. Instala, prueba y compila:
```
npm install
npx jest
npm run build
```
   Deben pasar **180 pruebas**.

3. Aplica la migración a la base de SIREP, igual que las anteriores (`npx supabase db push`, o en SQL Editor si así las aplican).

4. Agrega a tu `.env` (no se sube al repo):
```
RPTECH_URL=https://mldjzjcmngazfyiemghp.supabase.co/functions/v1/importar-historico
RPTECH_CLAVE=<la clave que te pasó Adrián por privado>
RPTECH_ENVIO_AUTOMATICO=true
BOT_CONFIG_ROLES=admin,operador
```

5. Simula el lote sin enviar nada:
```
npm run db:migrar-revisados -- --dry-run
```
   Muestra cuántos reportes se enviarían y qué datos no tienen el formato del contrato. Esos datos van en `datos_originales`.

6. Envía **un** reporte desde la bandeja (`PATCH /reportes/:numero/importar`). Debe quedar `aprobado_rptech` con su `rptech_id`. Avisa a Adrián para que lo revise en RP-TECH.

7. Si salió bien, envía el resto:
```
npm run db:migrar-revisados
```

8. Commit, push de la rama y PR.

## Qué cambia para el revisor

- **Al terminar de revisar un reporte se envía solo a RP-TECH.** Si no quieres que sea automático, pon `RPTECH_ENVIO_AUTOMATICO=false` y envíalo con el botón o el lote.
- **Si RP-TECH lo rechaza**, queda `observado`. El motivo de cada campo está en `rptech_error`. Se corrige en la bandeja y se vuelve a enviar.
- **Si no hay conexión**, el reporte queda como estaba y se envía en el próximo intento.
- **Un reporte que ya está en RP-TECH no se puede reabrir**, porque allá entra cerrado y no se modifica.
- **Ya no se envían a RP-TECH** los ids de las tablas propias de SIREP (cliente, equipo y técnico). El vínculo lo hace el coordinador en RP-TECH.

## Ya probado

- Las 180 pruebas de `sirep-back` pasan: las 148 anteriores, 22 del envío y 10 de la configuración del bot.
- Se probó el código de envío contra la función real de RP-TECH en local:
  - un reporte nuevo se guardó;
  - el reenvío dio `ya_existia` sin duplicar;
  - un talonario repetido quedó `observado`;
  - una clave mala dio `clave_invalida`.
- En RP-TECH llegaron bien la fecha, las opciones, los voltajes, la hora en formato de 24 h, los dos repuestos, las casillas y los textos sin formato en `datos_originales`.

## Configuración del bot (backend)

El backend de SIREP es uno solo. Lo que puede cambiar es su dirección pública, por ejemplo otro túnel de ngrok u otro dominio.

- `GET /configuracion/bot` muestra el bot, si está conectado, a qué dirección le manda Telegram los mensajes, la cola y el último error.
- `PUT /configuracion/bot` con `{ "url": "https://..." }` vuelve a conectar el bot a la dirección nueva.
- `DELETE /configuracion/bot` lo desconecta. Telegram guarda los mensajes hasta que se vuelva a conectar.

**Seguridad:**
- Antes de conectar, el backend se llama a sí mismo por la dirección escrita (`/configuracion/bot/eco/:codigo`, con un código de un solo uso). Si la dirección no llega a este mismo backend, no conecta. Así nadie puede mandar las fotos de los reportes a otro servidor desde la pantalla.
- Solo se acepta https, y los mensajes en cola no se pierden.
- Solo los roles de `BOT_CONFIG_ROLES` lo cambian; los demás solo lo ven.

La API de reportes ahora devuelve también `rptech_id`, `rptech_error` y `rptech_enviado_en`, para mostrar en la bandeja si el reporte ya está en RP-TECH o por qué se rechazó.
