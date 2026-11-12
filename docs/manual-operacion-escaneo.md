# Manual de Operación de Escaneo y Envío por Telegram (David y Valentino)

Este manual describe el procedimiento diario para digitalizar los reportes técnicos físicos archivados en folders (entre 400 y 500 reportes) y enviarlos al sistema **SIREP**.

---

## 1. Preparación antes de escanear

1. Trabaja un folder a la vez para mantener el orden físico de las hojas.
2. Retira grapas o clips antes de colocar la hoja en el alimentador o cristal de la impresora multifuncional.
3. Verifica el **N° impreso del talonario** en la esquina superior derecha del reporte (por ejemplo, `000845`).

---

## 2. Configuración del escáner

Configura la impresora multifuncional con estos parámetros fijos:

- **Formato de archivo:** `PDF` (un solo archivo por reporte).
- **Color:** A color (permite distinguir sellos, firmas y trazos de lapicero azul/negro/rojo).
- **Resolución:** `300 dpi`.
- **Caras:** Si el reporte tiene anotaciones al reverso, escanea **anverso y reverso en el mismo archivo PDF** (máximo 4 páginas por archivo).

---

## 3. Cómo nombrar el archivo

Nombra cada archivo PDF con el **N° impreso del talonario** de 6 dígitos:

- Ejemplo correcto: `000845.pdf`
- Ejemplo alternativo si también envías el número en el mensaje: `reporte_000845.pdf`

---

## 4. Cómo enviar el reporte al Bot de Telegram

1. Abre Telegram desde la PC e ingresa al chat oficial del **Bot de SIREP**.
   - *Nota:* El bot solo acepta envíos desde las cuentas autorizadas de **David** y **Valentino**.
2. Adjunta el archivo PDF como **Documento / Archivo** (un reporte a la vez).
3. En el comentario (caption) del archivo puedes escribir el N° del reporte (por ejemplo `000845`) para mayor seguridad.
4. Al enviarlo, el bot responderá primero:
   > `Procesando reporte con IA, por favor espera un momento...`
5. En unos segundos recibirás la confirmación con el resumen de los campos leídos:
   > `Reporte N° 000845 registrado`
6. Marca o separa el reporte físico como **Escaneado** en el folder y continúa con el siguiente.

---

## 5. Qué hacer ante avisos del Bot

| Aviso que muestra el Bot | Qué significa | Qué debes hacer |
| :--- | :--- | :--- |
| **`Acceso no autorizado`** | Estás escribiendo desde una cuenta de Telegram que no está en la lista autorizada. | Envía al coordinador el **ID de chat** que aparece en el mensaje para que habilite tu cuenta. |
| **`Este archivo ya fue enviado anteriormente`** | Subiste por error exactamente el mismo archivo PDF dos veces. | **No hagas nada.** El sistema bloqueó el duplicado automáticamente; pasa al siguiente reporte. |
| **`El reporte N° XXXXXX ya se encuentra registrado`** | Ese número de talonario ya fue ingresado antes en el sistema. | Verifica en el papel si el número escrito en el nombre del archivo era correcto. Si la hoja ya había sido escaneada antes, pasa al siguiente reporte. |
| **`Solo puedo procesar PDF o imágenes`** | Se adjuntó por error un archivo Word, Excel u otro formato. | Vuelve a enviar únicamente el archivo `.pdf`, `.jpg` o `.png`. |
| **`El archivo pesa más de 20 MB`** | El PDF excede el límite de descarga de Telegram. | Vuelve a escanear esa hoja a `200 dpi` y envíala nuevamente. |
| **`No pude leer el reporte con la IA en este momento`** | El proveedor de IA tuvo una saturación temporal. **No se guardó nada.** | Espera 1 o 2 minutos y vuelve a reenviar el mismo archivo PDF. Si se repite 3 veces seguidas, avisa al equipo de soporte. |
| **`Atención: pasó a la Bandeja de Revisión por campos dudosos`** | El reporte **sí quedó guardado**, pero tiene letra manuscrita difícil en uno o más campos. | **No vuelvas a enviarlo.** El revisor técnico completará esos campos desde la Bandeja de Revisión web. |
