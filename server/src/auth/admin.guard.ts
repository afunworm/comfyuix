import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from "@nestjs/common";

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (req.user?.role !== 'admin') throw new ForbiddenException();
    return true;
  }
}
