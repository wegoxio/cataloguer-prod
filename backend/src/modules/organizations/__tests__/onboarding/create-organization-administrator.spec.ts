import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CreateOrganizationAdministratorDto } from '../../dto/create-organization-administrator.dto';
import { OrganizationsController } from '../../organizations.controller';
import { ROLES_KEY } from '../../../auth/decorators/roles.decorator';

/**
 * POST /organizations/:id/administrators (Phase 4).
 *
 * The one supported path that can create an ORGANIZATION_MANAGER: every other
 * route derives the company FROM a store, which that role may not carry, so
 * both two-step orderings pass through an illegal binding. This spec pins the
 * two properties that make the new route safe rather than merely convenient:
 * only the platform owner reaches it, and a body cannot smuggle a role,
 * store or different organization in — loudly, not by silent strip.
 */
describe('POST /organizations/:id/administrators', () => {
  it('is platform-only: the class @Roles(SUPER_ADMIN) applies with no per-method loosening', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, OrganizationsController.prototype.createAdministrator)).toBeUndefined();
    expect(reflector.get(ROLES_KEY, OrganizationsController)).toEqual(['SUPER_ADMIN']);
  });

  describe('the DTO refuses forbidden fields BY NAME (forbidNonWhitelisted)', () => {
    // The exact pipe configuration the route declares.
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const meta: ArgumentMetadata = { type: 'body', metatype: CreateOrganizationAdministratorDto };
    const valid = { email: 'qa-placeholder@example.com', firstName: 'Q', lastName: 'A' };

    it('accepts the minimal legal body', async () => {
      const out = await pipe.transform(valid, meta);
      expect(out).toBeInstanceOf(CreateOrganizationAdministratorDto);
      expect(out.email).toBe(valid.email);
    });

    it.each([
      ['role', { ...valid, role: 'SUPER_ADMIN' }],
      ['storeId', { ...valid, storeId: 'store-1' }],
      ['organizationId', { ...valid, organizationId: 'org-2' }],
    ])('refuses %s with a 400 naming the property — never a silent strip', async (property, body) => {
      const err = await pipe.transform(body, meta).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      const response = (err as BadRequestException).getResponse() as { message: string[] };
      expect(JSON.stringify(response.message)).toContain(property);
    });

    it('refuses a malformed email', async () => {
      await expect(pipe.transform({ email: 'not-an-email' }, meta)).rejects.toThrow(BadRequestException);
    });
  });
});
