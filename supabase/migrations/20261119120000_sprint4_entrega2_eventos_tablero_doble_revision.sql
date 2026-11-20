-- ==============================================================================
-- SIREP Sprint 4 — Entrega 2 (Jueves 19):
-- SIREP-S4-T05: Registro de eventos inmutable (append-only)
-- SIREP-S4-T08: Columnas para doble revisión aleatoria del 5%
-- ==============================================================================

-- 1. Tabla propia e inmutable de eventos de revisión e ingesta
create table if not exists public.eventos_revision (
  id bigint generated always as identity primary key,
  empresa_id uuid not null default '00000000-0000-0000-0000-000000000000'::uuid,
  usuario_id uuid,
  usuario text not null,
  reporte text,
  campo text,
  tipo_accion text not null
    check (tipo_accion in ('tomar', 'confirmar', 'corregir', 'marcar_ilegible', 'cerrar', 'liberar', 'subir')),
  detalle jsonb not null default '{}'::jsonb,
  creado_en timestamptz not null default now()
);

create index if not exists idx_eventos_revision_creado_en
  on public.eventos_revision (creado_en desc);

create index if not exists idx_eventos_revision_usuario_id
  on public.eventos_revision (usuario_id);

create index if not exists idx_eventos_revision_reporte
  on public.eventos_revision (reporte);

create index if not exists idx_eventos_revision_tipo_accion
  on public.eventos_revision (tipo_accion, creado_en desc);

-- Trigger append-only: los eventos no se modifican ni se borran nunca (SIREP-S4-T05)
create or replace function public.impedir_mutacion_eventos_revision()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Los eventos de revisión son inmutables y no pueden modificarse ni eliminarse.';
end;
$$;

drop trigger if exists trg_eventos_revision_inmutable on public.eventos_revision;

create trigger trg_eventos_revision_inmutable
  before update or delete on public.eventos_revision
  for each row
  execute function public.impedir_mutacion_eventos_revision();

alter table public.eventos_revision enable row level security;

-- 2. Columnas opcionales de doble revisión en public.reportes (SIREP-S4-T08)
alter table public.reportes
  add column if not exists doble_revision_estado text
    check (doble_revision_estado is null or doble_revision_estado in ('pendiente', 'completada')),
  add column if not exists doble_revision_por text,
  add column if not exists doble_revision_coincidencia numeric(5, 2);

create index if not exists idx_reportes_doble_revision_estado
  on public.reportes (doble_revision_estado)
  where doble_revision_estado is not null;
