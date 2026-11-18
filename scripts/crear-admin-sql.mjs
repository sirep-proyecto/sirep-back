/**
 * Genera el SQL para crear la cuenta de administrador principal.
 * No toca la base: imprime un INSERT que se pega en el SQL Editor de Supabase.
 *
 * Uso:  node scripts/crear-admin-sql.mjs <usuario> "<Nombre visible>" "<contraseña>"
 * Ej.:  node scripts/crear-admin-sql.mjs alfonso "Alfonso" "MiClaveSegura123"
 *
 * Cuando ya existe un administrador, el resto de las cuentas se crean desde la app
 * (Configuración > Usuarios y accesos).
 */
import { randomBytes, scryptSync } from 'node:crypto';

const [usuario, nombre, password] = process.argv.slice(2);

if (!usuario || !nombre || !password) {
  console.error('Uso: node scripts/crear-admin-sql.mjs <usuario> "<Nombre visible>" "<contraseña>"');
  process.exit(1);
}
if (!/^[a-zA-Z0-9._@-]{3,60}$/.test(usuario)) {
  console.error('El usuario debe tener de 3 a 60 caracteres: letras, números, punto, guion, guion bajo o @.');
  process.exit(1);
}
if (password.length < 8) {
  console.error('La contraseña debe tener al menos 8 caracteres.');
  process.exit(1);
}

const sal = randomBytes(16).toString('hex');
const hash = `scrypt$${sal}$${scryptSync(password, sal, 64).toString('hex')}`;
const q = (t) => `'${String(t).replace(/'/g, "''")}'`;

console.log(`-- Administrador principal de SIREP
insert into public.usuarios (usuario, nombre, rol, permisos, password_hash, creado_por)
values (
  ${q(usuario.toLowerCase())},
  ${q(nombre.trim())},
  'admin',
  array['ver_reportes','editar_campos','cerrar_reportes','subir_escaneos','exportar','configurar_bot','gestionar_usuarios'],
  ${q(hash)},
  'instalación'
);`);
