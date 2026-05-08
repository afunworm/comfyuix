import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  ForbiddenException,
  ParseIntPipe,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AdminGuard } from "../auth/admin.guard";
import { UsersService } from "./users.service";

@Controller('users')
@UseGuards(JwtAuthGuard, AdminGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Post()
  async adminCreate(
    @Body() body: { username: string; email: string; password: string; role?: string },
  ) {
    const user = await this.usersService.create(body.username, body.email, body.password, body.role ?? 'user');
    this.usersService.verifyEmail(user.id);
    return this.usersService.findById(user.id);
  }

  @Put(':id')
  async adminUpdate(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { username?: string; email?: string; role?: string; is_disabled?: number; password?: string },
    @Req() req: any,
  ) {
    await this.usersService.updateUser(id, body);
    return this.usersService.findById(id);
  }

  @Delete(':id')
  adminDelete(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    if (req.user.id === id) throw new ForbiddenException('Cannot delete yourself');
    this.usersService.deleteUser(id);
    return { deleted: true };
  }
}
