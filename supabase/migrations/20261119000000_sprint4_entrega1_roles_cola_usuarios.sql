-- ==============================================================================
-- SIREP Sprint 4 — Entrega 1 (Miércoles 18):
-- SIREP-S4-T01: Roles en BD (administrador, ingestor, revisor) y múltiples roles
-- SIREP-S4-T03: Cola libre con reserva (1 por revisor, expiración a las 4 horas)
-- SIREP-S4-T04: Los 7 usuarios reales con contraseñas cifradas (scrypt)
-- ==============================================================================

-- 1. Ampliar public.usuarios para soportar roles del Sprint 4 y múltiples roles por persona
alter table public.usuarios
  add column if not exists roles text[] not null default array[]::text[];

alter table public.usuarios
  drop constraint if exists usuarios_rol_check;

drop index if exists public.idx_usuarios_un_solo_admin;

-- Homologar roles anteriores a los nombres oficiales del Sprint 4
update public.usuarios
set rol = case
  when rol = 'admin' then 'administrador'
  when rol = 'operador' then 'ingestor'
  when rol = 'supervisor' then 'revisor'
  else rol
end
where rol in ('admin', 'operador', 'supervisor');

update public.usuarios
set roles = array[rol]
where cardinality(roles) = 0;

update public.usuarios
set permisos = array_append(permisos, 'usar_cola')
where rol = 'revisor' and not ('usar_cola' = any(permisos));

alter table public.usuarios
  add constraint usuarios_rol_check
  check (rol in ('administrador', 'ingestor', 'revisor', 'admin', 'supervisor', 'operador'));

-- 2. Columnas de Cola Libre con Reserva en public.reportes (SIREP-S4-T03)
alter table public.reportes
  add column if not exists reservado_por_id uuid references public.usuarios(id) on delete set null,
  add column if not exists reservado_por text,
  add column if not exists reservado_en timestamptz;

create index if not exists idx_reportes_reservado_por_id
  on public.reportes(reservado_por_id);

create index if not exists idx_reportes_cola_pendientes
  on public.reportes(empresa_id, creado_en asc);

-- 3. Semilla idempotente de los 7 usuarios reales del equipo (SIREP-S4-T04)
-- Contraseñas iniciales cifradas con scrypt:
--   wilber    -> Wilber2026!
--   david     -> David2026!
--   valentino -> Valentino2026!
--   adriana   -> Adriana2026!
--   fabian    -> Fabian2026!
--   jean      -> Jean2026!
--   darwin    -> Darwin2026!
delete from public.usuarios
where lower(usuario) not in ('wilber', 'david', 'valentino', 'adriana', 'fabian', 'jean', 'darwin');

do $$
declare
  rec record;
begin
  for rec in
    select * from (values
      (
        'wilber',
        'Wilber Peralta',
        'administrador',
        array['administrador']::text[],
        array['ver_reportes','usar_cola','editar_campos','cerrar_reportes','subir_escaneos','exportar','configurar_bot','gestionar_usuarios']::text[],
        'scrypt$73697265705f73345f73616c745f7769$618a9dae75953d45ab298c85506fd1f4c18f93a9539238419bdb81abb20a0c92479676d2665774d878a23ef238e0356db5e7111ed8232697472d361b6f0144fe'
      ),
      (
        'david',
        'David',
        'ingestor',
        array['ingestor']::text[],
        array['ver_reportes','subir_escaneos']::text[],
        'scrypt$73697265705f73345f73616c745f6461$9550ea7b3f37e3b8d93a01314adfd795cb6f0b2593675224350202bf9db6aafed52f9c8293fdf91a1c8c11bc3204f7f84b552c533903ba243ae6cc25e2ff68d1'
      ),
      (
        'valentino',
        'Valentino',
        'ingestor',
        array['ingestor']::text[],
        array['ver_reportes','subir_escaneos']::text[],
        'scrypt$73697265705f73345f73616c745f7661$5567a95449190601d25b6861735ff39d33a346f10070caa03222cd716132347c9d27d011160c00db502d59629b22481a6972c21499b508d6e92e095e93a93459'
      ),
      (
        'adriana',
        'Adriana',
        'revisor',
        array['revisor']::text[],
        array['ver_reportes','usar_cola','editar_campos','cerrar_reportes']::text[],
        'scrypt$73697265705f73345f73616c745f6164$35972a166960856d4421a36064b5632ce2558ef7762c379da90c850e13354c6fb224baddca1245c14b98b16417b58e51d65f29f1f5e312b2c966bc321ddf9e7d'
      ),
      (
        'fabian',
        'Fabián',
        'revisor',
        array['revisor']::text[],
        array['ver_reportes','usar_cola','editar_campos','cerrar_reportes']::text[],
        'scrypt$73697265705f73345f73616c745f6661$bcd2d75e89fa6d87f70da9387f54e9209685a88598336068ae5a81b676d8def6f5a725c50f76e76612da35eb6910a23a015f5297dc263be59f8b94dba0c635af'
      ),
      (
        'jean',
        'Jean',
        'revisor',
        array['revisor']::text[],
        array['ver_reportes','usar_cola','editar_campos','cerrar_reportes']::text[],
        'scrypt$73697265705f73345f73616c745f6a65$5f7104acb2c8133788c7754edb7f2c036c0516dc108db0ca24d95138b85d1d50cac5630664d06ca6e1f73edf3ab24eb81abf89e859881e515db36289f2abfed5'
      ),
      (
        'darwin',
        'Darwin',
        'revisor',
        array['revisor']::text[],
        array['ver_reportes','usar_cola','editar_campos','cerrar_reportes']::text[],
        'scrypt$73697265705f73345f73616c745f6461$5a5a22efd50f10f0d57dda0e79d2ff7ab7fbde102eba13c968115ce0ffbe125130ded5f369550ffce7db6150f798792ddd833cdcbdd689befcba003a762c4ef9'
      )
    ) as t(u, n, r, rs, perms, ph)
  loop
    if exists (select 1 from public.usuarios where lower(usuario) = lower(rec.u)) then
      update public.usuarios
      set nombre = rec.n,
          rol = rec.r,
          roles = rec.rs,
          permisos = rec.perms,
          activo = true,
          actualizado_en = now()
      where lower(usuario) = lower(rec.u);
    else
      insert into public.usuarios (usuario, nombre, rol, roles, permisos, password_hash, activo, creado_por)
      values (rec.u, rec.n, rec.r, rec.rs, rec.perms, rec.ph, true, 'sprint4-seed');
    end if;
  end loop;
end $$;
