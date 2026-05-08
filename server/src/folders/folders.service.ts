import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type FolderType = 'input' | 'output';

export class CreateFolderDto {
  name: string;
  type: FolderType;
  bookId?: string;
}

export class RenameFolderDto {
  name: string;
}

@Injectable()
export class FoldersService {
  private readonly db;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.db;
  }

  create(userId: number, dto: CreateFolderDto) {
    if (!['input', 'output'].includes(dto.type)) {
      throw new BadRequestException("type must be 'input' or 'output'");
    }

    const result = this.db
      .prepare(`INSERT INTO asset_folder (name, type, user_id, book_id) VALUES (?, ?, ?, ?)`)
      .run(dto.name.trim(), dto.type, userId, dto.bookId ?? null);

    return this.db
      .prepare('SELECT * FROM asset_folder WHERE id = ?')
      .get(result.lastInsertRowid);
  }

  findByUser(userId: number, bookId?: string, type?: FolderType) {
    if (bookId && type) {
      return this.db
        .prepare(`SELECT * FROM asset_folder WHERE user_id = ? AND book_id = ? AND type = ? ORDER BY name ASC`)
        .all(userId, bookId, type);
    }
    if (bookId) {
      return this.db
        .prepare(`SELECT * FROM asset_folder WHERE user_id = ? AND book_id = ? ORDER BY type ASC, name ASC`)
        .all(userId, bookId);
    }
    if (type) {
      return this.db
        .prepare(`SELECT * FROM asset_folder WHERE user_id = ? AND type = ? ORDER BY name ASC`)
        .all(userId, type);
    }
    return this.db
      .prepare(`SELECT * FROM asset_folder WHERE user_id = ? ORDER BY type ASC, name ASC`)
      .all(userId);
  }

  rename(id: number, userId: number, dto: RenameFolderDto) {
    const folder = this.db
      .prepare('SELECT id FROM asset_folder WHERE id = ? AND user_id = ?')
      .get(id, userId);
    if (!folder) throw new NotFoundException('Folder not found or not yours');

    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('name is required');

    this.db
      .prepare('UPDATE asset_folder SET name = ? WHERE id = ?')
      .run(name, id);
    return this.db.prepare('SELECT * FROM asset_folder WHERE id = ?').get(id);
  }

  remove(id: number, userId: number) {
    const folder = this.db
      .prepare('SELECT id FROM asset_folder WHERE id = ? AND user_id = ?')
      .get(id, userId);
    if (!folder) throw new NotFoundException('Folder not found or not yours');

    // Delete all assets in this folder, then the folder itself (in a transaction)
    const transaction = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM asset WHERE folder_id = ? AND user_id = ?')
        .run(id, userId);
      this.db.prepare('DELETE FROM asset_folder WHERE id = ?').run(id);
    });
    transaction();

    return { deleted: true };
  }
}
