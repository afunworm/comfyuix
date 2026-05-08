import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Request,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { QuickFlowsService } from './quick-flows.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('quick-flows')
@UseGuards(JwtAuthGuard)
export class QuickFlowsController {
  constructor(private readonly service: QuickFlowsService) {}

  // ── Grouped view ─────────────────────────────────────────────────────────────

  /** GET /quick-flows — all groups with nested flows */
  @Get()
  getAll(@Request() req) {
    return this.service.getAllGrouped(req.user.id);
  }

  // ── Groups ───────────────────────────────────────────────────────────────────

  @Post('groups')
  createGroup(@Request() req, @Body() body: { name: string }) {
    return this.service.createGroup(req.user.id, body.name);
  }

  @Patch('groups/:id')
  renameGroup(
    @Param('id', ParseIntPipe) id: number,
    @Request() req,
    @Body() body: { name: string },
  ) {
    return this.service.renameGroup(req.user.id, id, body.name);
  }

  @Patch('groups/reorder')
  reorderGroups(@Request() req, @Body() body: { ids: number[] }) {
    this.service.reorderGroups(req.user.id, body.ids);
  }

  @Delete('groups/:id')
  deleteGroup(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.service.deleteGroup(req.user.id, id);
  }

  // ── Flows ────────────────────────────────────────────────────────────────────

  @Post('flows')
  createFlow(
    @Request() req,
    @Body()
    body: {
      name: string;
      group_id?: number | null;
      api_data: string;
      image_node_id: string;
      seed_node_id?: string | null;
      positive_prompt_node_id?: string | null;
      preset_options?: string;
      ask_on_run?: string;
    },
  ) {
    return this.service.createFlow(req.user.id, body);
  }

  @Patch('flows/reorder')
  reorderFlows(@Request() req, @Body() body: { ids: number[] }) {
    this.service.reorderFlows(req.user.id, body.ids);
  }

  @Patch('flows/:id')
  updateFlow(
    @Param('id', ParseIntPipe) id: number,
    @Request() req,
    @Body()
    body: {
      name?: string;
      group_id?: number | null;
      api_data?: string;
      image_node_id?: string;
      seed_node_id?: string | null;
      positive_prompt_node_id?: string | null;
      preset_options?: string;
      ask_on_run?: string;
    },
  ) {
    return this.service.updateFlow(req.user.id, id, body);
  }

  @Delete('flows/:id')
  deleteFlow(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.service.deleteFlow(req.user.id, id);
  }
}
