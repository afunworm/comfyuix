import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { UsersService } from "../users/users.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
	constructor(private usersService: UsersService) {
		super({
			jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
			secretOrKey: process.env.JWT_SECRET ?? "changeme-in-production",
		});
	}

	validate(payload: { sub: number; username: string; role?: string }) {
		const user = this.usersService.findById(payload.sub);
		if (!user) throw new UnauthorizedException();
		if (user.is_disabled) throw new UnauthorizedException('Account is disabled');
		return { id: user.id, username: user.username, role: user.role };
	}
}
