# Manual del Revisor — Bandeja de Revisión y Exportación (SIREP)

Este manual explica cómo ingresar a la **Bandeja de Revisión de SIREP**, verificar y corregir los campos dudosos extraídos de los reportes manuscritos y exportar la base consolidada a Excel.

---

## 1. Inicio de sesión

1. Ingresa desde el navegador en tu PC a la dirección de la **Bandeja de Revisión de SIREP**.
2. Introduce tu **usuario o correo electrónico** y tu **contraseña** asignada.
   - Sin sesión iniciada no es posible consultar reportes, ver imágenes de escaneos ni guardar cambios.
   - Toda confirmación o corrección que realices quedará registrada automáticamente con tu nombre de usuario y la fecha/hora exacta.

---

## 2. Estados de los reportes en la bandeja

En la pantalla principal verás la lista de reportes recibidos por Telegram con su estado actual:

- **Procesado (Pendiente):** El modelo de IA leyó el escaneo y detectó uno o más campos con letra dudosa, baja confianza o ilegibles que requieren revisión humana.
- **En revisión:** Un revisor ya corrigió o confirmó parte de los campos del reporte, pero aún quedan campos pendientes por resolver.
- **Completo:** Todos los campos del reporte están validados y listos para exportación e integración con RP-TECH.

Puedes filtrar la lista para ver únicamente los reportes con campos pendientes.

---

## 3. Cómo revisar y corregir un reporte

1. Haz clic sobre un reporte de la lista para abrir la **Vista de Corrección**.
2. A la izquierda verás el visor con el escaneo original a color (puedes hacer zoom y cambiar de página si tiene reverso).
3. A la derecha verás los campos del formulario junto con el **recorte de la zona del papel** correspondiente a cada campo:
   - **Confirmar:** Si el valor que leyó la IA coincide con lo escrito en el papel, pulsa **Confirmar**.
   - **Corregir:** Si la IA leyó mal una palabra, código, fecha o nombre, escribe el texto correcto leyendo el recorte del papel y pulsa **Guardar / Corregir**. El sistema conserva tanto lo que leyó el modelo como tu corrección.
   - **Marcar como ilegible:** Si ni siquiera viendo el escaneo original se puede descifrar lo escrito por el técnico, márcalo como **Ilegible** (nunca adivines un dato).
   - **Reabrir:** Si confirmaste o corregiste un campo por error, puedes pulsar **Reabrir** para volver a editarlo.
4. Cuando resuelvas el último campo pendiente del reporte, su estado pasará automáticamente a **Completo**.

---

## 4. Exportación a Excel

1. Desde la barra superior de la Bandeja de Revisión, haz clic en **Exportar a Excel** (o accede a `/reportes/exportar/excel`).
2. Se descargará el archivo `reportes_sirep_AAAA-MM-DD.xlsx` (también disponible en `.csv` con codificación UTF-8 para tildes y eñes).
3. El archivo Excel contiene todos los campos del formulario con los nombres de columna acordados con **RP-TECH**, ubicando en las **primeras 10 columnas los campos vitales**:
   1. `numero_talonario` (N° de talonario)
   2. `fecha` (Fecha)
   3. `tecnico_asignado` (Técnico)
   4. `cliente` (Cliente)
   5. `serie_equipo` (Equipo)
   6. `motivo` (Motivo)
   7. `procedimiento` (Procedimiento)
   8. `conclusion` (Conclusión)
   9. `hora_llegada` (Hora de llegada)
   10. `hora_salida` (Hora de salida)
   *(seguidos de los 22 campos restantes del formulario y las columnas de auditoría: `origen`, `estado_reporte`, `corregido_por`, `creado_en`, `actualizado_en`).*
