import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ImportMappingTemplate } from '../entities/import-mapping-template.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { ShapeDrift, describeShapeDrift, fingerprintSourceShape } from '../plan/plan-hash';
import { TableMapping } from '../preview/normalized-preview';
import { Issue, issue } from '../issues/issue-taxonomy';
import { validateChain } from '../transform/transformations';

/**
 * Saving and reusing a mapping.
 *
 * Templates are what make the second import of a recurring export cheap — the
 * customer who uploads the same WooCommerce report every month should not remap
 * forty-five columns each time. They are also the single most dangerous feature
 * in the wizard, because a template applied to a file whose columns moved would
 * map prices onto costs *without anyone re-reading the screen*. The whole point
 * of the mapping step is that a person looked; a template is a way of not
 * looking.
 *
 * So reuse is never silent. Every template records the shape of the file it was
 * built against, and applying it to a different shape produces findings that
 * describe exactly what moved. The template still applies — refusing outright
 * would make the feature useless the first time someone adds a column — but the
 * person is told, by name, which columns changed.
 *
 * Versions are immutable. Editing a template creates version n+1 rather than
 * rewriting version n, because a plan executed last month referenced the mapping
 * as it was then, and rewriting history under it would make the audit trail
 * describe something that never happened.
 */

export interface TemplateShape {
  headers: string[];
  types: string[];
}

export interface AppliedTemplate {
  template: ImportMappingTemplate;
  mapping: TableMapping;
  drift: ShapeDrift;
  issues: Issue[];
  /** Columns whose mapping could not be carried over, by header. */
  droppedColumns: string[];
}

@Injectable()
export class MappingTemplateService {
  constructor(private readonly em: EntityManager) {}

  /**
   * Save a mapping as a new template, or as a new version of an existing one.
   *
   * The version is computed from what is already stored rather than supplied by
   * the caller: two people saving at once must not both claim version 3, and the
   * unique index on (organization, name, version) is what settles it.
   */
  async save(params: {
    organizationId: string;
    name: string;
    importType: string;
    mapping: TableMapping;
    shape: TemplateShape;
    userId?: string | null;
  }): Promise<ImportMappingTemplate> {
    const name = params.name.trim();
    if (name === '') throw new BadRequestException('A template needs a name.');

    // A template carrying an operation this version cannot perform would fail
    // at execution time, long after the person who saved it has moved on.
    const chainErrors = params.mapping.columns.flatMap((c) => validateChain(c.transformations ?? []));
    if (chainErrors.length > 0) {
      throw new BadRequestException(`This mapping cannot be saved: ${chainErrors.join(' ')}`);
    }

    const latest = await this.em.getConnection().execute<{ version: number }[]>(
      `select coalesce(max(version), 0) as version
         from import_mapping_templates
        where organization_id = ? and name = ?`,
      [params.organizationId, name],
    );
    const version = Number(latest[0]?.version ?? 0) + 1;

    const now = new Date();
    const template = this.em.create(ImportMappingTemplate, {
      organization: this.em.getReference(Organization, params.organizationId),
      name,
      version,
      importType: params.importType,
      sourceFingerprint: fingerprintSourceShape(params.shape.headers, params.shape.types),
      sourceHeaders: { headers: params.shape.headers, types: params.shape.types },
      mapping: params.mapping as unknown,
      createdByUserId: params.userId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    await this.em.persistAndFlush(template);
    return template;
  }

  /** Every template this organization can reuse, newest version of each name. */
  async listLatest(organizationId: string, importType?: string): Promise<ImportMappingTemplate[]> {
    const all = await this.em.find(
      ImportMappingTemplate,
      {
        organization: organizationId,
        archivedAt: null,
        ...(importType ? { importType } : {}),
      },
      { orderBy: { name: 'asc', version: 'desc' } },
    );

    const seen = new Set<string>();
    return all.filter((t) => {
      if (seen.has(t.name)) return false;
      seen.add(t.name);
      return true;
    });
  }

  /**
   * Load one template, refusing anything outside the caller's organization.
   *
   * The refusal is a 404 rather than a 403 on purpose: telling a caller that a
   * template exists but belongs to someone else is itself a disclosure, and a
   * template's name can carry a customer's own vocabulary.
   */
  async load(organizationId: string, templateId: string): Promise<ImportMappingTemplate> {
    const template = await this.em.findOne(ImportMappingTemplate, {
      id: templateId,
      organization: organizationId,
    });
    if (!template) throw new NotFoundException('That saved mapping no longer exists.');
    return template;
  }

  /**
   * Apply a stored template to the file in front of us.
   *
   * Columns are re-bound **by header name, not by position**. Position is the
   * thing that moves: someone inserts a column in their export and every
   * position-bound mapping silently shifts by one, which is exactly the failure
   * that would write prices into costs.
   */
  applyToSource(template: ImportMappingTemplate, shape: TemplateShape): AppliedTemplate {
    const stored = template.mapping as TableMapping;
    const storedShape = (template.sourceHeaders as TemplateShape | null) ?? { headers: [], types: [] };

    const drift = describeShapeDrift(storedShape.headers, storedShape.types, shape.headers, shape.types);

    const norm = (h: string) => (h || '').trim().toLowerCase();
    const currentByHeader = new Map<string, number>();
    shape.headers.forEach((header, index) => {
      // First occurrence wins; a duplicate header is already reported
      // separately and picking the later one would be arbitrary.
      if (!currentByHeader.has(norm(header))) currentByHeader.set(norm(header), index);
    });

    const columns: TableMapping['columns'] = [];
    const droppedColumns: string[] = [];

    for (const column of stored.columns) {
      const index = currentByHeader.get(norm(column.header));
      if (index === undefined) {
        droppedColumns.push(column.header);
        continue;
      }
      // The header shown is the FILE's, not the template's. The editor renders
      // these beside the actual columns, and labelling one "Precio" when the
      // file says "PRECIO" makes the person doubt the binding is right.
      columns.push({ ...column, columnIndex: index, header: shape.headers[index] });
    }

    // Columns present now that the template never saw. They arrive unmapped and
    // unreviewed, so the editor asks about them rather than ignoring them.
    for (const [header, index] of currentByHeader) {
      if (!stored.columns.some((c) => norm(c.header) === header)) {
        columns.push({
          columnIndex: index,
          header: shape.headers[index],
          field: null,
          reasons: ['This column is new since the saved mapping was made.'],
        });
      }
    }

    columns.sort((a, b) => a.columnIndex - b.columnIndex);

    return {
      template,
      mapping: { ...stored, columns },
      drift,
      droppedColumns,
      issues: describeDriftAsIssues(template, drift, droppedColumns, stored.sheet),
    };
  }

  /** Archive a template so it stops being offered, without destroying history. */
  async archive(organizationId: string, templateId: string): Promise<void> {
    const template = await this.load(organizationId, templateId);
    template.archivedAt = new Date();
    await this.em.flush();
  }
}

/**
 * Turn drift into findings the person can act on.
 *
 * Severity is chosen by what the change could do, not by how large it is:
 *
 *  - a **removed** column means a field the template mapped is simply not there,
 *    so that field would be silently dropped. Warning.
 *  - a **retyped** column is the dangerous one — a price column that now reads
 *    as text, or an id column that became a number — because the mapping still
 *    "works" and produces wrong values. Warning, prominently.
 *  - **added** columns and **reordering** are informational. Re-binding happens
 *    by header name, so a reorder does not move any mapping; saying so out loud
 *    is what stops someone assuming the worst.
 */
function describeDriftAsIssues(
  template: ImportMappingTemplate,
  drift: ShapeDrift,
  droppedColumns: string[],
  sheet?: string,
): Issue[] {
  if (!drift.drifted && droppedColumns.length === 0) return [];

  const issues: Issue[] = [];
  const anchor = { sheet };

  if (droppedColumns.length > 0) {
    issues.push(
      issue(
        'COLUMN_UNMAPPED',
        `The saved mapping "${template.name}" refers to ${droppedColumns.length} column(s) this file does not have: ${droppedColumns.map((c) => `"${c}"`).join(', ')}.`,
        {
          severity: 'WARNING',
          anchor,
          guidance: 'Those fields will not be imported. Map them to another column, or confirm they are not needed.',
        },
      ),
    );
  }

  for (const retyped of drift.retyped) {
    issues.push(
      issue(
        'HEADER_AMBIGUOUS',
        `Column "${retyped.header}" held ${retyped.was} values when this mapping was saved and now holds ${retyped.now} values.`,
        {
          severity: 'WARNING',
          anchor: { ...anchor, column: retyped.header },
          guidance: 'Check the transformations on this column still make sense for the new content.',
        },
      ),
    );
  }

  if (drift.added.length > 0) {
    issues.push(
      issue('COLUMN_UNMAPPED', `This file has ${drift.added.length} column(s) the saved mapping did not cover.`, {
        severity: 'INFORMATIONAL',
        anchor,
        guidance: 'Map them if you need them, or leave them ignored.',
      }),
    );
  }

  if (drift.reordered) {
    issues.push(
      issue('RAGGED_ROWS', 'The columns are in a different order than when this mapping was saved.', {
        severity: 'INFORMATIONAL',
        anchor,
        guidance: 'The mapping follows column names rather than positions, so nothing has moved out of place.',
      }),
    );
  }

  return issues;
}
