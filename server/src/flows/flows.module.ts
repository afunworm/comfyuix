import { Module } from "@nestjs/common";
import { FlowsService } from "./flows.service";
import { FlowsController } from "./flows.controller";
import { BooksModule } from "../books/books.module";

@Module({
	imports: [BooksModule], // needed to inject BooksService for access checks
	providers: [FlowsService],
	controllers: [FlowsController],
})
export class FlowsModule {}
