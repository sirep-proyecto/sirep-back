import { Body, Controller, Get, HttpCode, Optional, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { ActividadService } from './actividad.service';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

export class LoginDto {
  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  usuario?: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Optional() private readonly actividad?: ActividadService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: LoginDto) {
    const identificador = body.email || body.usuario || '';
    const sesion = await this.auth.iniciarSesion(identificador, body.password);
    this.actividad?.registrar(sesion.usuario, 'sesion_iniciada');
    return sesion;
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  perfil(@Req() req: any) {
    return { usuario: req.usuario };
  }
}
