-- Clave de Gemini propia de cada cuenta (Configuración > Mi clave de Gemini).
-- Solo agrega una tabla nueva: no modifica ni borra nada existente.
--
-- Por qué: Gemini limita las lecturas por minuto POR PROYECTO de Google. Si cada persona
-- lee con su propia clave (creada en su propia cuenta), cada una tiene su propio cupo y
-- varias pueden subir reportes a la vez sin frenarse entre sí.
--
-- Al subir un reporte desde la página se usa, en este orden: la clave personal de quien
-- lo sube, la de la empresa (configuracion_ia) y la del servidor (GEMINI_API_KEY).
-- Si la personal falla (inválida o sin cupo) se reintenta con la de la empresa y queda
-- anotado aquí el último error, para que la persona lo vea.
--
-- La clave va cifrada por el backend (AES-256-GCM con IA_CLAVES_SECRETO o AUTH_JWT_SECRET),
-- igual que en configuracion_ia: aquí nunca hay una clave en texto plano.

create table if not exists public.claves_ia_usuario (
  usuario_id uuid primary key references public.usuarios(id) on delete cascade,
  proveedor text not null default 'gemini' check (proveedor = 'gemini'),
  clave_cifrada text not null,
  -- Cuatro últimos caracteres, para reconocerla en pantalla sin descifrarla
  clave_final text,
  modelo text,
  activa boolean not null default true,
  lecturas integer not null default 0,
  ultimo_uso_en timestamptz,
  ultimo_error text,
  ultimo_error_en timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

-- El backend usa la service_role key y salta RLS. Sin políticas, nadie más
-- (anon / authenticated) puede leer las claves cifradas.
alter table public.claves_ia_usuario enable row level security;

comment on table public.claves_ia_usuario is
  'Clave de Gemini propia de cada cuenta, cifrada por el backend. Se usa al subir reportes desde la página.';
