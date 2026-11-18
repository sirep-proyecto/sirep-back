-- Bitácora de lo que hace cada cuenta (revisar, cerrar, subir, exportar, cambiar accesos).
-- Solo agrega una tabla nueva y un índice: no modifica ni borra datos existentes.

create table if not exists public.actividad_usuarios (
  id bigint generated always as identity primary key,
  usuario_id uuid,
  -- Nombre visible de la cuenta en el momento de la acción (se conserva aunque luego se renombre o elimine la cuenta).
  usuario text not null,
  accion text not null,
  detalle jsonb not null default '{}'::jsonb,
  creado_en timestamptz not null default now()
);

create index if not exists idx_actividad_usuarios_creado_en on public.actividad_usuarios (creado_en desc);
create index if not exists idx_actividad_usuarios_usuario_id on public.actividad_usuarios (usuario_id);

alter table public.actividad_usuarios enable row level security;

-- El nombre visible identifica en la bandeja a quien revisó cada reporte: no puede repetirse.
-- (Requiere que ya exista la tabla public.usuarios.)
create unique index if not exists idx_usuarios_nombre_unico on public.usuarios (lower(nombre));
