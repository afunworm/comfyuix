import { Module } from '@nestjs/common';
import { MultirunPresetsService } from './multirun-presets.service';
import { MultirunPresetsController } from './multirun-presets.controller';
import { BooksModule } from '../books/books.module';

@Module({
	imports: [BooksModule],
	providers: [MultirunPresetsService],
	controllers: [MultirunPresetsController],
})
export class MultirunPresetsModule {}
