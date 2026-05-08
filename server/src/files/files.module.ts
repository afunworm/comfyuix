import { Module } from "@nestjs/common";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";
import { DatabaseModule } from "../database/database.module";
import { UsersModule } from "../users/users.module";

@Module({
	imports: [DatabaseModule, UsersModule],
	controllers: [FilesController],
	providers: [FilesService],
})
export class FilesModule {}
