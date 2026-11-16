-- ==============================================================================
-- Envío del histórico a RP-TECH (contrato docs/contrato-historico.md, versión 1)
-- Solo agrega columnas: no borra ni cambia datos existentes.
--   rptech_id         id del reporte en RP-TECH, cuando RP-TECH confirmó que lo guardó
--   rptech_error      último rechazo o fallo de envío ({ codigo, detalle }), para corregirlo
--   rptech_enviado_en último intento de envío
-- ==============================================================================

alter table public.reportes
  add column if not exists rptech_id uuid,
  add column if not exists rptech_error jsonb,
  add column if not exists rptech_enviado_en timestamptz;

comment on column public.reportes.rptech_id is
  'Id del reporte en RP-TECH. Solo se llena cuando RP-TECH responde creado o ya_existia.';

create index if not exists idx_reportes_rptech_id on public.reportes(rptech_id);
