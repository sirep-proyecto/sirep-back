-- ==============================================================================
-- SIREP: Columnas completas del formulario y Dataset Actualizable de Clientes/Contactos
-- Preparado para migración limpia a la base de datos original (RP-TECH)
-- ==============================================================================

-- 1. Asegurar todas las columnas del formulario físico en `public.reportes`
--    (incluyendo `contacto` y `telefono` para vincular usuarios con locales).
alter table public.reportes
  add column if not exists telefono text,
  add column if not exists contacto text,
  add column if not exists ultimo_mantenimiento text,
  add column if not exists limpieza_equipo text,
  add column if not exists cabezales text,
  add column if not exists sistema_proteccion text,
  add column if not exists tinta text,
  add column if not exists revision_linea_ln text,
  add column if not exists revision_linea_lt text,
  add column if not exists revision_linea_nt text,
  add column if not exists operador text,
  add column if not exists repuestos_tipo text,
  add column if not exists repuestos_descripcion text,
  add column if not exists repuestos_cantidad text,
  add column if not exists garantia text,
  add column if not exists facturado text,
  add column if not exists firma_operador text,
  add column if not exists firma_cliente text;

create index if not exists idx_reportes_cliente on public.reportes(cliente);
create index if not exists idx_reportes_contacto on public.reportes(contacto);

-- 2. Tabla de Dataset Actualizable (Clientes, Direcciones de Locales y Contactos Registrados)
create table if not exists public.dataset_clientes (
  id uuid default gen_random_uuid() primary key,
  empresa_id uuid not null default '00000000-0000-0000-0000-000000000000'::uuid,
  clave_normalizada text not null,
  nombre_cliente text not null,
  direcciones text[] not null default array[]::text[],
  contactos text[] not null default array[]::text[],
  direccion_por_contacto jsonb not null default '{}'::jsonb,
  correcciones jsonb not null default '[]'::jsonb,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (empresa_id, clave_normalizada)
);

create index if not exists idx_dataset_clientes_empresa on public.dataset_clientes(empresa_id);

drop trigger if exists trg_dataset_clientes_actualizado_en on public.dataset_clientes;
create trigger trg_dataset_clientes_actualizado_en
  before update on public.dataset_clientes
  for each row execute function public.set_actualizado_en();
