import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { UsersModule } from "../users/users.module";
import { SettingsModule } from "../settings/settings.module";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { SetupController } from "./setup.controller";
import { JwtStrategy } from "./jwt.strategy";

@Module({
	imports: [
		UsersModule,
		SettingsModule,
		PassportModule,
		JwtModule.register({
			secret: process.env.JWT_SECRET ?? "changeme-in-production",
			signOptions: { expiresIn: "30d" },
		}),
	],
	providers: [AuthService, JwtStrategy],
	controllers: [AuthController, SetupController],
	exports: [JwtModule],
})
export class AuthModule {}
