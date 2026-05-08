import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Request,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { FoldersService, CreateFolderDto, RenameFolderDto } from './folders.service';
import type { FolderType } from './folders.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('folders')
@UseGuards(JwtAuthGuard)
export class FoldersController {
  constructor(private foldersService: FoldersService) {}

  /** GET /folders?bookId=...&type=input */
  @Get()
  findByUser(@Request() req, @Query('bookId') bookId?: string, @Query('type') type?: FolderType) {
    return this.foldersService.findByUser(req.user.id, bookId, type);
  }

  @Post()
  create(@Request() req, @Body() dto: CreateFolderDto) {
    return this.foldersService.create(req.user.id, dto);
  }

  @Patch(':id')
  rename(
    @Param('id', ParseIntPipe) id: number,
    @Request() req,
    @Body() dto: RenameFolderDto,
  ) {
    return this.foldersService.rename(id, req.user.id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.foldersService.remove(id, req.user.id);
  }
}
