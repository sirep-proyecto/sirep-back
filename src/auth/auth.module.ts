import { Global, Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ActividadInterceptor } from './actividad.interceptor';
import { ActividadService } from './actividad.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { UsuariosController } from './usuarios.controller';
import { UsuariosService } from './usuarios.service';

@Global()
@Module({
  imports: [CommonModule],
  controllers: [AuthController, UsuariosController],
  providers: [AuthService, AuthGuard, UsuariosService, ActividadService, ActividadInterceptor],
  exports: [AuthService, AuthGuard, UsuariosService, ActividadService, ActividadInterceptor],
})
export class AuthModule {}
