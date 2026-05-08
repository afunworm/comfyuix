import { Global, Module } from "@nestjs/common";
import { DatabaseService } from "./database.service";

@Global() // makes DatabaseService available everywhere without re-importing
@Module({
	providers: [DatabaseService],
	exports: [DatabaseService],
})
export class DatabaseModule {}
