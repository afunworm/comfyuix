import { Module } from "@nestjs/common";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { AccountController } from "./account.controller";

@Module({
	controllers: [UsersController, AccountController],
	providers: [UsersService],
	exports: [UsersService],
})
export class UsersModule {}
