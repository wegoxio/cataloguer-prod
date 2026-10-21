import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ImportWizardController } from '../wizard.controller';
import { MappingTemplateService } from '../../templates/mapping-template.service';
import { ROLES_KEY } from '../../../auth/decorators/roles.decorator';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';
import { PreviewMappingDto } from '../wizard.dto';
import { WIZARD_CONTRACT_VERSION } from '../wizard-contract';

/**
 * The wizard's API surface: who may reach it, and what the preview route is
 * allowed to do.
 *
 * Building a mapping is the first half of an act that rewrites catalogue data
 * organization-wide, so the authority has to match the commit that follows it.
 * Offering the editor to someone who could never run it would be a strange
 * courtesy, and offering it to someone who then COULD run it would be a hole.
 */

const ORG_A = 'org-a';

const scopeOf = (over: Partial<TenantScope> = {}): TenantScope =>
  ({
    platform: false,
    role: 'ORGANIZATION_MANAGER',
    organizationId: ORG_A,
    storeId: null,
    allowedStoreIds: [],
    ...over,
  }) as TenantScope;

const unscopedPlatformOwner = scopeOf({ platform: true, role: 'SUPER_ADMIN', organizationId: null as never });

const templates = {
  listLatest: jest.fn(),
  save: jest.fn(),
  load: jest.fn(),
  applyToSource: jest.fn(),
  archive: jest.fn(),
} as unknown as MappingTemplateService;

const controller = new ImportWizardController(templates);

const previewBody = (over: Partial<PreviewMappingDto> = {}): PreviewMappingDto =>
  ({
    importType: 'PRODUCTS',
    sample: {
      sheet: 'Productos',
      firstRowNumber: 2,
      headers: ['Nombre', 'Precio'],
      rows: [['Camiseta', '19,99']],
    },
    mapping: {
      sheet: 'Productos',
      headerRow: 1,
      columns: [
        { columnIndex: 0, header: 'Nombre', field: 'name' },
        {
          columnIndex: 1,
          header: 'Precio',
          field: 'price',
          transformations: [{ kind: 'PARSE_DECIMAL', options: { decimalSeparator: ',' } }],
        },
      ],
    },
    ...over,
  }) as PreviewMappingDto;

describe('who may use the wizard', () => {
  const reflector = new Reflector();

  it('restricts every route to the roles that could also commit the import', () => {
    const methods = ['contract', 'preview', 'listTemplates', 'saveTemplate', 'applyTemplate', 'archiveTemplate'];
    for (const method of methods) {
      const roles = reflector.get<string[]>(
        ROLES_KEY,
        (ImportWizardController.prototype as unknown as Record<string, () => unknown>)[method],
      );
      expect(roles).toEqual(['SUPER_ADMIN', 'ORGANIZATION_MANAGER']);
    }
  });

  it('refuses a platform owner who has not entered a company', () => {
    // There is no unfiltered wizard: a platform administrator must name the
    // company through X-Managed-Organization, exactly as for import itself.
    expect(() => controller.contract({ scope: unscopedPlatformOwner })).toThrow(ForbiddenException);
    expect(() => controller.preview({ scope: unscopedPlatformOwner }, previewBody())).toThrow(ForbiddenException);
  });

  it('refuses a request with no resolved scope at all', () => {
    expect(() => controller.preview({ scope: undefined }, previewBody())).toThrow(ForbiddenException);
  });
});

describe('the served contract', () => {
  it('tells the editor what this build can do, with a version', () => {
    // Served rather than hardcoded, so the editor cannot offer an operation
    // this deployment would refuse at execution time.
    const { data } = controller.contract({ scope: scopeOf() });
    expect(data.version).toBe(WIZARD_CONTRACT_VERSION);
    expect(data.transformations.length).toBeGreaterThan(5);
    expect(data.supportedTransformations).toContain('PARSE_DECIMAL');
    expect(data.issueSeverities.DUPLICATE_IDENTITY_IN_FILE).toBe('BLOCKING');
  });
});

describe('previewing a mapping', () => {
  it('returns the normalized rows and what makes them so', () => {
    const { data } = controller.preview({ scope: scopeOf() }, previewBody());
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].sourceRow).toBe(2);
    expect(data.rows[0].values).toEqual({ name: 'Camiseta', price: 19.99 });
    expect(data.rows[0].cells[1].original).toBe('19,99');
  });

  it('answers the editor’s real question: may this run, and if not why', () => {
    const { data } = controller.preview({ scope: scopeOf() }, previewBody());
    expect(data.readiness).toEqual({ allowed: true });
    expect(data.summary.blocking).toBe(0);
  });

  it('explains the blocker in a sentence when it cannot run', () => {
    const body = previewBody({
      mapping: {
        sheet: 'Productos',
        headerRow: 1,
        columns: [
          { columnIndex: 0, header: 'Nombre', field: 'price' },
          { columnIndex: 1, header: 'Precio', field: 'price' },
        ],
      } as never,
    });
    const { data } = controller.preview({ scope: scopeOf() }, body);
    expect(data.readiness.allowed).toBe(false);
    expect(data.readiness.reason).toMatch(/must be fixed/);
    expect(data.issues.some((i) => i.code === 'DUPLICATE_FIELD_MAPPING')).toBe(true);
  });

  it('groups repeated findings rather than returning one per row', () => {
    const body = previewBody({
      sample: {
        sheet: 'Productos',
        firstRowNumber: 2,
        headers: ['Nombre', 'Precio'],
        rows: Array.from({ length: 60 }, (_, i) => [`Producto ${i}`, 'consultar']),
      } as never,
    });
    const { data } = controller.preview({ scope: scopeOf() }, body);
    const prices = data.issues.find((i) => i.code === 'VALUE_NOT_PARSEABLE');
    expect(prices?.count).toBe(25); // the default preview sample size
    expect(prices?.examples.length).toBeLessThanOrEqual(5);
  });

  it('refuses a mapping that points past the end of the file', () => {
    // Not a per-row data problem: the mapping and the sample disagree about
    // which file they describe, and reporting it 800 times would bury it.
    const body = previewBody({
      mapping: {
        sheet: 'Productos',
        headerRow: 1,
        columns: [{ columnIndex: 7, header: 'Fantasma', field: 'name' }],
      } as never,
    });
    expect(() => controller.preview({ scope: scopeOf() }, body)).toThrow(BadRequestException);
  });

  it('refuses a sample whose cells are absurdly large', () => {
    const body = previewBody({
      sample: {
        firstRowNumber: 2,
        headers: ['Nombre'],
        rows: [['x'.repeat(3 * 1024 * 1024)]],
      } as never,
    });
    expect(() => controller.preview({ scope: scopeOf() }, body)).toThrow(BadRequestException);
  });

  it('writes nothing and reads nothing from storage', () => {
    // The route is pure by design: the same function runs at validation time
    // before execution, which is what makes the two agree.
    controller.preview({ scope: scopeOf() }, previewBody());
    expect(templates.load).not.toHaveBeenCalled();
    expect(templates.save).not.toHaveBeenCalled();
  });
});

describe('templates through the API', () => {
  beforeEach(() => jest.clearAllMocks());

  it('saves against the caller’s own company, never one supplied in the body', () => {
    (templates.save as jest.Mock).mockResolvedValue({ id: 't1', name: 'Mensual', version: 1 });
    return controller
      .saveTemplate({ scope: scopeOf(), user: { id: 'u1' } }, {
        name: 'Mensual',
        importType: 'PRODUCTS',
        mapping: previewBody().mapping as never,
        headers: ['Nombre', 'Precio'],
        types: ['TEXT', 'DECIMAL'],
      } as never)
      .then(() => {
        expect((templates.save as jest.Mock).mock.calls[0][0]).toMatchObject({
          organizationId: ORG_A,
          userId: 'u1',
        });
      });
  });

  it('refuses a shape whose names and types do not line up', async () => {
    await expect(
      controller.saveTemplate({ scope: scopeOf() }, {
        name: 'Mensual',
        importType: 'PRODUCTS',
        mapping: previewBody().mapping as never,
        headers: ['Nombre', 'Precio'],
        types: ['TEXT'],
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(templates.save).not.toHaveBeenCalled();
  });

  it('returns drift alongside the rebound mapping, never the mapping alone', async () => {
    // A template applied without its drift findings is the one case where the
    // wizard could write wrong values with nobody having looked.
    (templates.load as jest.Mock).mockResolvedValue({ id: 't1', name: 'Mensual', version: 2 });
    (templates.applyToSource as jest.Mock).mockReturnValue({
      mapping: { headerRow: 1, columns: [] },
      drift: { drifted: true, added: [], removed: ['Coste'], reordered: false, retyped: [] },
      droppedColumns: ['Coste'],
      issues: [{ code: 'COLUMN_UNMAPPED', severity: 'WARNING', message: 'Coste is missing.' }],
    });

    const { data } = await controller.applyTemplate({ scope: scopeOf() }, 't1', {
      headers: ['Nombre'],
      types: ['TEXT'],
    } as never);

    expect(data.drift.drifted).toBe(true);
    expect(data.droppedColumns).toEqual(['Coste']);
    expect(data.issues).toHaveLength(1);
    expect(data.summary.unacknowledgedWarnings).toBe(1);
  });

  it('scopes listing and archiving to the caller’s company', async () => {
    (templates.listLatest as jest.Mock).mockResolvedValue([]);
    await controller.listTemplates({ scope: scopeOf() }, 'PRODUCTS');
    expect(templates.listLatest).toHaveBeenCalledWith(ORG_A, 'PRODUCTS');

    (templates.archive as jest.Mock).mockResolvedValue(undefined);
    await controller.archiveTemplate({ scope: scopeOf() }, 't1');
    expect(templates.archive).toHaveBeenCalledWith(ORG_A, 't1');
  });
});
