import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface QuickFlowGroup {
  id: number;
  user_id: number;
  name: string;
  sort_order: number;
  created_at: string;
}

export interface QuickFlow {
  id: number;
  user_id: number;
  group_id: number | null;
  name: string;
  api_data: string;
  image_node_id: string;
  seed_node_id: string | null;
  positive_prompt_node_id: string | null;
  preset_options: string;
  ask_on_run: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class QuickFlowsService {
  private readonly db;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.db;
  }

  // ── Groups ──────────────────────────────────────────────────────────────────

  getGroups(userId: number): QuickFlowGroup[] {
    return this.db
      .prepare(`SELECT * FROM quick_flow_group WHERE user_id = ? ORDER BY sort_order ASC, id ASC`)
      .all(userId) as QuickFlowGroup[];
  }

  createGroup(userId: number, name: string): QuickFlowGroup {
    if (!name?.trim()) throw new BadRequestException('name is required');
    const maxOrder = (this.db
      .prepare(`SELECT MAX(sort_order) as m FROM quick_flow_group WHERE user_id = ?`)
      .get(userId) as any)?.m ?? -1;
    const result = this.db
      .prepare(`INSERT INTO quick_flow_group (user_id, name, sort_order) VALUES (?, ?, ?)`)
      .run(userId, name.trim(), maxOrder + 1);
    return this.db
      .prepare(`SELECT * FROM quick_flow_group WHERE id = ?`)
      .get(result.lastInsertRowid) as QuickFlowGroup;
  }

  renameGroup(userId: number, groupId: number, name: string): QuickFlowGroup {
    if (!name?.trim()) throw new BadRequestException('name is required');
    const group = this.db
      .prepare(`SELECT id FROM quick_flow_group WHERE id = ? AND user_id = ?`)
      .get(groupId, userId);
    if (!group) throw new NotFoundException('Group not found');
    this.db.prepare(`UPDATE quick_flow_group SET name = ? WHERE id = ?`).run(name.trim(), groupId);
    return this.db.prepare(`SELECT * FROM quick_flow_group WHERE id = ?`).get(groupId) as QuickFlowGroup;
  }

  reorderGroups(userId: number, ids: number[]): void {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const check = this.db.prepare(`SELECT id FROM quick_flow_group WHERE id = ? AND user_id = ?`);
    const update = this.db.prepare(`UPDATE quick_flow_group SET sort_order = ? WHERE id = ?`);
    this.db.transaction(() => {
      ids.forEach((id, i) => {
        if (!check.get(id, userId)) throw new NotFoundException(`Group ${id} not found`);
        update.run(i, id);
      });
    })();
  }

  deleteGroup(userId: number, groupId: number): { deleted: boolean } {
    const group = this.db
      .prepare(`SELECT id FROM quick_flow_group WHERE id = ? AND user_id = ?`)
      .get(groupId, userId);
    if (!group) throw new NotFoundException('Group not found');
    this.db.transaction(() => {
      // Unlink flows (set group_id to NULL rather than delete them)
      this.db.prepare(`UPDATE quick_flow SET group_id = NULL WHERE group_id = ?`).run(groupId);
      this.db.prepare(`DELETE FROM quick_flow_group WHERE id = ?`).run(groupId);
    })();
    return { deleted: true };
  }

  // ── Flows ───────────────────────────────────────────────────────────────────

  getFlows(userId: number, groupId?: number): QuickFlow[] {
    if (groupId !== undefined) {
      return this.db
        .prepare(`SELECT * FROM quick_flow WHERE user_id = ? AND group_id = ? ORDER BY sort_order ASC, id ASC`)
        .all(userId, groupId) as QuickFlow[];
    }
    return this.db
      .prepare(`SELECT * FROM quick_flow WHERE user_id = ? ORDER BY sort_order ASC, id ASC`)
      .all(userId) as QuickFlow[];
  }

  getAllGrouped(userId: number): Array<QuickFlowGroup & { flows: QuickFlow[] }> {
    const groups = this.getGroups(userId);
    const flows = this.getFlows(userId);
    return groups.map((g) => ({
      ...g,
      flows: flows.filter((f) => f.group_id === g.id),
    }));
  }

  createFlow(
    userId: number,
    dto: { name: string; group_id?: number | null; api_data: string; image_node_id: string; seed_node_id?: string | null; positive_prompt_node_id?: string | null; preset_options?: string; ask_on_run?: string },
  ): QuickFlow {
    if (!dto.name?.trim()) throw new BadRequestException('name is required');
    if (!dto.api_data) throw new BadRequestException('api_data is required');
    if (!dto.image_node_id?.trim()) throw new BadRequestException('image_node_id is required');

    // Validate api_data is valid JSON
    try { JSON.parse(dto.api_data); } catch {
      throw new BadRequestException('api_data must be valid JSON');
    }

    const groupId = dto.group_id ?? null;
    if (groupId !== null) {
      const group = this.db
        .prepare(`SELECT id FROM quick_flow_group WHERE id = ? AND user_id = ?`)
        .get(groupId, userId);
      if (!group) throw new NotFoundException('Group not found');
    }

    const maxOrder = (this.db
      .prepare(`SELECT MAX(sort_order) as m FROM quick_flow WHERE user_id = ?`)
      .get(userId) as any)?.m ?? -1;

    const seedNodeId = dto.seed_node_id?.trim() || null;
    const positivePromptNodeId = dto.positive_prompt_node_id?.trim() || null;
    const presetOptions = dto.preset_options ?? '[]';
    const askOnRun = dto.ask_on_run ?? '[]';

    const result = this.db
      .prepare(
        `INSERT INTO quick_flow (user_id, group_id, name, api_data, image_node_id, seed_node_id, positive_prompt_node_id, preset_options, ask_on_run, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, groupId, dto.name.trim(), dto.api_data, dto.image_node_id.trim(), seedNodeId, positivePromptNodeId, presetOptions, askOnRun, maxOrder + 1);

    return this.db.prepare(`SELECT * FROM quick_flow WHERE id = ?`).get(result.lastInsertRowid) as QuickFlow;
  }

  updateFlow(
    userId: number,
    flowId: number,
    dto: { name?: string; group_id?: number | null; api_data?: string; image_node_id?: string; seed_node_id?: string | null; positive_prompt_node_id?: string | null; preset_options?: string; ask_on_run?: string },
  ): QuickFlow {
    const flow = this.db
      .prepare(`SELECT * FROM quick_flow WHERE id = ? AND user_id = ?`)
      .get(flowId, userId) as QuickFlow | undefined;
    if (!flow) throw new NotFoundException('Quick flow not found');

    const name = dto.name?.trim() ?? flow.name;
    const imageNodeId = dto.image_node_id?.trim() ?? flow.image_node_id;
    const seedNodeId = 'seed_node_id' in dto ? (dto.seed_node_id?.trim() || null) : flow.seed_node_id;
    const positivePromptNodeId = 'positive_prompt_node_id' in dto ? (dto.positive_prompt_node_id?.trim() || null) : flow.positive_prompt_node_id;
    const presetOptions = 'preset_options' in dto ? (dto.preset_options ?? '[]') : flow.preset_options;
    const askOnRun = 'ask_on_run' in dto ? (dto.ask_on_run ?? '[]') : flow.ask_on_run;
    let apiData = flow.api_data;

    if (dto.api_data !== undefined) {
      try { JSON.parse(dto.api_data); } catch {
        throw new BadRequestException('api_data must be valid JSON');
      }
      apiData = dto.api_data;
    }

    const groupId = 'group_id' in dto ? (dto.group_id ?? null) : flow.group_id;

    if (groupId !== null) {
      const group = this.db
        .prepare(`SELECT id FROM quick_flow_group WHERE id = ? AND user_id = ?`)
        .get(groupId, userId);
      if (!group) throw new NotFoundException('Group not found');
    }

    this.db
      .prepare(
        `UPDATE quick_flow SET name = ?, group_id = ?, api_data = ?, image_node_id = ?, seed_node_id = ?, positive_prompt_node_id = ?, preset_options = ?, ask_on_run = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(name, groupId, apiData, imageNodeId, seedNodeId, positivePromptNodeId, presetOptions, askOnRun, flowId);

    return this.db.prepare(`SELECT * FROM quick_flow WHERE id = ?`).get(flowId) as QuickFlow;
  }

  reorderFlows(userId: number, ids: number[]): void {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const check = this.db.prepare(`SELECT id FROM quick_flow WHERE id = ? AND user_id = ?`);
    const update = this.db.prepare(`UPDATE quick_flow SET sort_order = ? WHERE id = ?`);
    this.db.transaction(() => {
      ids.forEach((id, i) => {
        if (!check.get(id, userId)) throw new NotFoundException(`Flow ${id} not found`);
        update.run(i, id);
      });
    })();
  }

  deleteFlow(userId: number, flowId: number): { deleted: boolean } {
    const flow = this.db
      .prepare(`SELECT id FROM quick_flow WHERE id = ? AND user_id = ?`)
      .get(flowId, userId);
    if (!flow) throw new NotFoundException('Quick flow not found');
    this.db.prepare(`DELETE FROM quick_flow WHERE id = ?`).run(flowId);
    return { deleted: true };
  }
}
