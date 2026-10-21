import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { requireOrganizationScope } from '../../auth/tenancy/tenant-assertions';
import { MappingTemplateService } from '../templates/mapping-template.service';
import { TableMapping, buildNormalizedPreview } from '../preview/normalized-preview';
import { groupIssues, summarize, canExecute, DEFAULT_SEVERITY } from '../issues/issue-taxonomy';
import { SUPPORTED_TRANSFORMATIONS } from '../transform/transformations';
import { ApplyTemplateDto, PreviewMappingDto, SaveTemplateDto, sampleWithinBudget } from './wizard.dto';
import { TRANSFORMATION_CATALOGUE, WIZARD_CONTRACT_VERSION } from './wizard-contract';

/**
 * The mapping wizard's API.
 *
 * Authority matches the existing import workflow exactly (P5-A2 family 4):
 * building a mapping is the first half of an act that rewrites catalogue data
 * organization-wide, so it belongs to the same roles that may commit it.
 * Exposing the editor to someone who could never run it would be a strange
 * courtesy.
 *
 * The preview route is deliberately **pure**. It takes a bounded sample and a
 * candidate mapping and returns what that mapping would produce — it reads no
 * source from storage and writes nothing. The editor re-previews on every
 * change, and re-reading a hundred-megabyte file from private storage on each
 * keystroke would be untenable; more importantly, the same function runs at
 * validation time before execution, which is what makes the two agree.
 */
const CATALOGUE_IMPORT_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER'] as const;

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('import/wizard')
export class ImportWizardController {
  constructor(private readonly templates: MappingTemplateService) {}

  /**
   * What this deployment can actually do.
   *
   * Served rather than hardcoded in the frontend so the editor renders the
   * operations this build supports instead of a list that drifted out of step
   * with it. A version accompanies it, so a stale tab can tell it is stale.
   */
  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Get('contract')
  contract(@Req() req: { scope?: unknown }) {
    requireOrganizationScope(req.scope as never);
    return {
      data: {
        version: WIZARD_CONTRACT_VERSION,
        transformations: TRANSFORMATION_CATALOGUE,
        supportedTransformations: SUPPORTED_TRANSFORMATIONS,
        issueSeverities: DEFAULT_SEVERITY,
      },
    };
  }

  /**
   * What this mapping would produce, cell by cell.
   *
   * Nothing is written and nothing is read from storage; the sample came from
   * analysis and is the customer's own data returning to them.
   */
  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Post('preview')
  preview(@Req() req: { scope?: unknown }, @Body() body: PreviewMappingDto) {
    requireOrganizationScope(req.scope as never);

    if (!sampleWithinBudget(body.sample)) {
      throw new BadRequestException('That preview sample is too large. Reduce the number of rows and try again.');
    }
    if (body.mapping.columns.some((c) => c.columnIndex >= body.sample.headers.length)) {
      // A mapping pointing past the end of the file is not a data problem to
      // report per row — it means the mapping and the sample disagree about
      // which file they describe.
      throw new BadRequestException('This mapping refers to a column that is not in the file.');
    }

    const mapping = body.mapping as unknown as TableMapping;
    const result = buildNormalizedPreview(body.sample.rows, body.sample.firstRowNumber, mapping, {
      importType: body.importType,
    });

    return {
      data: {
        rows: result.rows,
        ignoredColumns: result.ignoredColumns,
        blankRowCount: result.blankRowCount,
        previewedRows: result.previewedRows,
        issues: groupIssues(result.issues),
        summary: summarize(result.issues),
        // The editor's primary affordance: whether the button is live, and if
        // not, the sentence explaining why.
        readiness: canExecute(result.issues),
      },
    };
  }

  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Get('templates')
  async listTemplates(@Req() req: { scope?: unknown }, @Query('importType') importType?: string) {
    const organizationId = requireOrganizationScope(req.scope as never);
    const templates = await this.templates.listLatest(organizationId, importType);
    return {
      data: templates.map((t) => ({
        id: t.id,
        name: t.name,
        version: t.version,
        importType: t.importType,
        updatedAt: t.updatedAt,
      })),
    };
  }

  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Post('templates')
  async saveTemplate(@Req() req: { scope?: unknown; user?: { id?: string } }, @Body() body: SaveTemplateDto) {
    const organizationId = requireOrganizationScope(req.scope as never);
    if (body.headers.length !== body.types.length) {
      throw new BadRequestException('The column names and their types do not line up.');
    }

    const saved = await this.templates.save({
      organizationId,
      name: body.name,
      importType: body.importType,
      mapping: body.mapping as unknown as TableMapping,
      shape: { headers: body.headers, types: body.types },
      userId: req.user?.id ?? null,
    });

    return { data: { id: saved.id, name: saved.name, version: saved.version } };
  }

  /**
   * Re-bind a saved mapping to the file in front of us.
   *
   * The response carries the drift findings alongside the mapping, because a
   * template applied without them is the one case where the wizard could write
   * the wrong values with nobody having looked.
   */
  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Post('templates/:id/apply')
  async applyTemplate(@Req() req: { scope?: unknown }, @Param('id') id: string, @Body() body: ApplyTemplateDto) {
    const organizationId = requireOrganizationScope(req.scope as never);
    if (body.headers.length !== body.types.length) {
      throw new BadRequestException('The column names and their types do not line up.');
    }

    const template = await this.templates.load(organizationId, id);
    const applied = this.templates.applyToSource(template, { headers: body.headers, types: body.types });

    return {
      data: {
        template: { id: template.id, name: template.name, version: template.version },
        mapping: applied.mapping,
        drift: applied.drift,
        droppedColumns: applied.droppedColumns,
        issues: groupIssues(applied.issues),
        summary: summarize(applied.issues),
      },
    };
  }

  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Delete('templates/:id')
  async archiveTemplate(@Req() req: { scope?: unknown }, @Param('id') id: string) {
    const organizationId = requireOrganizationScope(req.scope as never);
    await this.templates.archive(organizationId, id);
    return { data: { archived: true } };
  }
}
