import { Module } from "@nestjs/common";
import { BookModelsController } from "./book-models.controller";
import { BookModelsService } from "./book-models.service";
import { DatabaseModule } from "../database/database.module";

@Module({
	imports: [DatabaseModule],
	controllers: [BookModelsController],
	providers: [BookModelsService],
})
export class BookModelsModule {}
