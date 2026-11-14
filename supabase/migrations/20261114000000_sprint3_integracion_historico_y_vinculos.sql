-- ==============================================================================
-- SIREP-S3-T09, T10, T12: Migración Aditiva para Reglas de Reporte Histórico,
-- Vinculación con Catálogos y Respaldo de Datos Originales
-- ==============================================================================
-- Regla estricta (SIREP-S3-T12): Solo sentencias aditivas (CREATE TABLE IF NOT EXISTS,
-- ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS y ampliación compatible de CHECK).
-- No elimina ni trunca datos existentes en producción.

-- 1. Tablas de catálogo para vinculación por similitud en la BD de SIREP
create table if not exists public.clientes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null default '00000000-0000-0000-0000-000000000000'::uuid,
  nombre text not null,
  ruc text,
  direccion text,
  telefono text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index if not exists idx_clientes_empresa_nombre
  on public.clientes(empresa_id, nombre);

create table if not exists public.equipos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null default '00000000-0000-0000-0000-000000000000'::uuid,
  nombre text not null,
  marca text,
  modelo text,
  serie text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index if not exists idx_equipos_empresa_nombre
  on public.equipos(empresa_id, nombre);

create table if not exists public.perfiles (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null default '00000000-0000-0000-0000-000000000000'::uuid,
  nombre text not null,
  rol text not null default 'tecnico',
  email text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index if not exists idx_perfiles_empresa_nombre
  on public.perfiles(empresa_id, nombre);

-- 2. Columnas aditivas en public.reportes para vínculos, histórico y cierre idempotente
alter table public.reportes
  add column if not exists cliente_id uuid references public.clientes(id) on delete set null,
  add column if not exists equipo_id uuid references public.equipos(id) on delete set null,
  add column if not exists tecnico_perfil_id uuid references public.perfiles(id) on delete set null,
  add column if not exists datos_originales jsonb not null default '{}'::jsonb,
  add column if not exists bloqueado boolean not null default false,
  add column if not exists importado_en timestamptz,
  -- Campos del flujo digital de RP-TECH que permanecen opcionales (NULL) para origen = 'historico'
  add column if not exists fotos_ingreso text[],
  add column if not exists fotos_salida text[],
  add column if not exists firmas_digitales_pad jsonb,
  add column if not exists numero_caso_crm text;

-- 3. Ampliación aditiva de estados permitidos para soportar cierre e importación idempotente
alter table public.reportes
  drop constraint if exists reportes_estado_reporte_check;

alter table public.reportes
  add constraint reportes_estado_reporte_check
  check (estado_reporte in ('pendiente_revision', 'aprobado', 'observado', 'aprobado_rptech', 'cerrado'));

-- 4. Índice único por empresa y N° de talonario (cuando no es nulo) y búsqueda de vínculos
create unique index if not exists idx_reportes_empresa_numero_talonario_unico
  on public.reportes(empresa_id, numero_talonario)
  where numero_talonario is not null;

create index if not exists idx_reportes_cliente_id on public.reportes(cliente_id);
create index if not exists idx_reportes_equipo_id on public.reportes(equipo_id);
create index if not exists idx_reportes_tecnico_perfil_id on public.reportes(tecnico_perfil_id);
create index if not exists idx_reportes_bloqueado on public.reportes(bloqueado);
