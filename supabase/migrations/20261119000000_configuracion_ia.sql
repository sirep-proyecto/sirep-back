-- Proveedor de IA que lee los reportes, elegido desde Configuración > Lectura con IA.
-- Solo agrega una tabla nueva: no modifica ni borra nada existente.
--
-- Una sola fila (id = 1). Se guarda una clave por proveedor: al cambiar de Gemini a
-- ChatGPT (o al revés) la del otro se conserva. Las claves van cifradas por el backend
-- (AES-256-GCM con IA_CLAVES_SECRETO o, si falta, AUTH_JWT_SECRET); aquí nunca hay
-- una clave en texto plano.
-- Si la tabla está vacía, el backend usa lo de las variables de entorno (IA_PROVEEDOR,
-- GEMINI_API_KEY, OPENAI_API_KEY…), como antes.

create table if not exists public.configuracion_ia (
  id smallint primary key default 1 check (id = 1),
  proveedor text not null default 'gemini' check (proveedor in ('gemini', 'openai')),
  modelo_gemini text,
  modelo_openai text,
  clave_gemini_cifrada text,
  clave_openai_cifrada text,
  actualizado_por text,
  actualizado_en timestamptz not null default now()
);

-- El backend usa la service_role key y salta RLS. Sin políticas, nadie más
-- (anon / authenticated) puede leer las claves cifradas.
alter table public.configuracion_ia enable row level security;
