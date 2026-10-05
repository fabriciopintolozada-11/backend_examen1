import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UserDocument } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async login({ email, password }: LoginDto): Promise<{ accessToken: string }> {
    const user = await this.usersService.findByEmailWithPassword(email);
    const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;

    // Mismo mensaje para correo inexistente y clave incorrecta (no revela cuentas)
    if (!user || !valid || !user.active) {
      throw new UnauthorizedException('Credenciales invalidas');
    }
    return this.issueToken(user);
  }

  // Cambia la clave propia. Los tokens anteriores quedan invalidos, asi que devuelve uno nuevo
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<{ accessToken: string }> {
    const user = await this.usersService.changePassword(userId, dto.currentPassword, dto.newPassword);
    return this.issueToken(user);
  }

  private async issueToken(user: UserDocument): Promise<{ accessToken: string }> {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    return { accessToken: await this.jwtService.signAsync(payload) };
  }
}
