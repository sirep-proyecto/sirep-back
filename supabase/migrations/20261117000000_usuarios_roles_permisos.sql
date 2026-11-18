-- Usuarios, roles y permisos administrados desde la app (Configuración > Usuarios y accesos).
-- Solo agrega una tabla nueva: no modifica ni borra nada existente.

create table if not exists public.usuarios (
  id uuid primary key default gen_random_uuid(),
  usuario text not null,
  nombre text not null,
  rol text not null default 'revisor'
    check (rol in ('admin', 'supervisor', 'operador')),
  -- Permisos concedidos a la cuenta. Para el rol admin se ignora: siempre tiene todos.
  permisos text[] not null default '{}',
  -- Contraseña con scrypt y sal propia (formato scrypt$sal$hash). Nunca en texto plano.
  password_hash text not null,
  activo boolean not null default true,
  creado_por text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  ultimo_acceso timestamptz
);

-- Solo puede existir una cuenta de administrador.
create unique index if not exists idx_usuarios_un_solo_admin
  on public.usuarios (rol) where rol = 'admin';

create unique index if not exists idx_usuarios_usuario_unico
  on public.usuarios (lower(usuario));

-- El backend usa la service_role key y salta RLS. Sin políticas, nadie más
-- (anon / authenticated) puede leer los hashes de contraseña.
alter table public.usuarios enable row level security;
