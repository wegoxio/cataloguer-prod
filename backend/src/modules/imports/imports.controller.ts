import {
  Req,
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { GenericImportService, ImportType } from './preview/generic-import.service';
import { FamilyLearningService } from '../products/families/family-learning.service';
import { ImportConcurrencyGuard } from './upload-security/import-concurrency.guard';
import { requireOrganizationScope } from '../auth/tenancy/tenant-assertions';
import { Body } from '@nestjs/common';

/**
 * P5-A2 family 4 (D-4.3). Import is ONE organization-wide administrative
 * workflow — preview, commit and history are the same act seen at three
 * moments, and a commit rewrites catalogue data well beyond any single branch.
 * Exposing part of it to a branch admin would be misleading, so the whole
 * workflow belongs to SUPER_ADMIN (explicitly scoped) and ORGANIZATION_MANAGER.
 *
 * Export is the opposite case and is governed separately: it is read-only, and
 * ADMIN already reads the catalogue.
 *
 * P5-A2 CANONICAL FAMILY 6 completes it. The role list above was the whole of
 * the earlier change; the company is now mandatory on EVERY route of the
 * workflow, including `supplier-order` commits, which previously slipped past
 * the organization requirement inside the service. A platform administrator
 * must name the company through `X-Managed-Organization`; there is no
 * unfiltered import, preview or history.
 */
const CATALOGUE_IMPORT_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER'] as const;

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('import')
export class ImportsController {
  constructor(
    private readonly genericImportService: GenericImportService,
    private readonly familyLearningService: FamilyLearningService,
  ) {}

  // Generic import, phase 1: parse a CSV and guess the mapping.
  // Concurrency guard + Multer byte limit (from ImportUploadSecurityModule)
  // admit and bound the upload BEFORE the body is buffered (#172).
  @Roles(...CATALOGUE_IMPORT_ROLES)
  @UseGuards(ImportConcurrencyGuard)
  @Post('preview')
  @UseInterceptors(FileInterceptor('file'))
  async preview(@Req() req: any, @UploadedFile() file: any, @Body() body: { type: ImportType }) {
    requireOrganizationScope(req.scope);
    if (!file?.buffer) throw new BadRequestException('File is required');
    // Phase 2: the company's learned vocabulary and dismissals shape proposals
    const [learnedWords, dismissedSignatures] = await Promise.all([
      // The request's resolved company, like every other reader of these two
      // lists — `requireOrganizationScope` above has already refused a request
      // without one.
      this.familyLearningService.learnedWordsFor(req.scope?.organizationId ?? null),
      this.familyLearningService.dismissedSignaturesFor(req.scope?.organizationId ?? null),
    ]);
    const preview = this.genericImportService.preview(
      body.type,
      { originalname: file.originalname, mimetype: file.mimetype, buffer: file.buffer },
      { learnedWords, dismissedSignatures },
    );
    // Field recognition (B4a3) is read-only and rides the canonical scope:
    // the target branch's importable fields match, the rest become proposals.
    const recognition = await this.genericImportService.recognizeFields(
      req.scope,
      body.type,
      preview.headers,
      preview.mapping,
    );
    // What each manufacturer code would match, resolved before anything is
    // written (P5-W1). Read-only and organization-scoped, exactly like field
    // recognition above; an ambiguity is reported here rather than discovered
    // as a refused row halfway through a commit.
    const manufacturerCodes = await this.genericImportService.manufacturerCodeMatchPreview(
      req.scope,
      body.type,
      preview.mapping,
      preview.rows,
    );
    return { data: { ...preview, ...recognition, ...manufacturerCodes } };
  }

}
