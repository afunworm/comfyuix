import { Module } from "@nestjs/common";
import { BooksService } from "./books.service";
import { BooksController } from "./books.controller";
import { TunnelModule } from "../tunnel/tunnel.module";

@Module({
	imports: [TunnelModule],
	providers: [BooksService],
	controllers: [BooksController],
	exports: [BooksService],
})
export class BooksModule {}
