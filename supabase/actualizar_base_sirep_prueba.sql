-- ==============================================================================
-- SIREP: actualización de una base que YA tiene las tablas `escaneos` y `reportes`
-- Proyecto de Supabase: SIREP_PRUEBA (organización FULLSTACK)
--
-- Cómo usarlo: Supabase Studio > SQL Editor > New query > pegar todo > Run.
-- Es idempotente: se puede ejecutar más de una vez sin dañar nada.
-- Equivale a las migraciones 20261102000100 y 20261103000000 del repositorio,
-- más el bucket de la migración inicial (por si no se creó).
-- ==============================================================================

-- 0. Bucket privado para los escaneos (si ya existe, no hace nada)
insert into storage.buckets (id, name, public)
values ('escaneos-originales', 'escaneos-originales', false)
on conflict (id) do nothing;

-- 1. Aviso claro si ya hay archivos repetidos: el índice único de abajo no se puede
--    crear con duplicados. Si salta este error, borra los duplicados y vuelve a ejecutar:
--      select empresa_id, huella, count(*) from public.escaneos
--      group by 1, 2 having count(*) > 1;
do $$
begin
  if exists (
    select 1 from public.escaneos group by empresa_id, huella having count(*) > 1
  ) then
    raise exception 'Hay escaneos con la misma huella en la misma empresa. Elimina los duplicados antes de continuar.';
  end if;
end $$;

-- 2. Un mismo archivo no puede registrarse dos veces por empresa
create unique index if not exists idx_escaneos_huella_empresa
  on public.escaneos(empresa_id, huella);

-- 3. actualizado_en se mantiene solo en cada UPDATE
create or replace function public.set_actualizado_en()
returns trigger
language plpgsql
as $$
begin
  new.actualizado_en = now();
  return new;
end;
$$;

drop trigger if exists trg_escaneos_actualizado_en on public.escaneos;
create trigger trg_escaneos_actualizado_en
  before update on public.escaneos
  for each row execute function public.set_actualizado_en();

drop trigger if exists trg_reportes_actualizado_en on public.reportes;
create trigger trg_reportes_actualizado_en
  before update on public.reportes
  for each row execute function public.set_actualizado_en();

-- 4. Columnas del formulario que `reportes` aún no tenía
alter table public.reportes
  add column if not exists direccion text,
  add column if not exists motivo text,
  add column if not exists estado_equipo text,
  add column if not exists conclusion text,
  add column if not exists recomendaciones text,
  add column if not exists hora_llegada text,
  add column if not exists hora_salida text;

create index if not exists idx_reportes_estado on public.reportes(estado_reporte);

-- 5. Que la API de Supabase vea las columnas nuevas de inmediato
notify pgrst, 'reload schema';

-- 6. Verificación: debe devolver las 7 columnas nuevas, el bucket, el índice y los 2 triggers
select 'columna' as tipo, column_name as nombre
  from information_schema.columns
 where table_schema = 'public' and table_name = 'reportes'
   and column_name in ('direccion','motivo','estado_equipo','conclusion','recomendaciones','hora_llegada','hora_salida')
union all
select 'bucket', id from storage.buckets where id = 'escaneos-originales'
union all
select 'indice', indexname from pg_indexes
 where schemaname = 'public' and indexname in ('idx_escaneos_huella_empresa','idx_reportes_estado')
union all
select 'trigger', tgname from pg_trigger
 where tgname in ('trg_escaneos_actualizado_en','trg_reportes_actualizado_en')
order by 1, 2;