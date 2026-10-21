import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SettingsController } from '../settings.controller';
import { DashboardMetricsController } from '../../dashboard-metrics/dashboard-metrics.controller';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';

/**
 * P5-A4 — the route half of #165 and #166.
 *
 * `RolesGuard` uses `getAllAndOverride`, so a METHOD-level `@Roles` REPLACES
 * the class list and an ABSENT list admits every authenticated role. Both facts
 * are pinned below, because #166 is precisely a case where the wrong reading of
 * that rule would widen access.
 */
const ALL_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN', 'EDITOR', 'VIEWER'];

const admits = (controller: any, handler: (...args: any[]) => unknown, roleName: string): boolean => {
  const guard = new RolesGuard(new Reflector());
  try {
    return (
      guard.canActivate({
        getHandler: () => handler,
        getClass: () => controller,
        switchToHttp: () => ({ getRequest: () => ({ user: { role: { name: roleName } } }) }),
      } as any) === true
    );
  } catch (error) {
    if (error instanceof ForbiddenException) return false;
    throw error;
  }
};

describe('#166 [P2-03] global Settings editable by ADMIN', () => {
  const SC = SettingsController.prototype;

  it('the class carries NO list, so every route must carry its own', () => {
    // An inherited class list is exactly how a method could widen by accident.
    expect(Reflect.getMetadata(ROLES_KEY, SettingsController)).toBeUndefined();
    for (const handler of [SC.announcement, SC.getSettings, SC.updateSettings]) {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeDefined();
    }
  });

  it('MUTATION of the global singleton is SUPER_ADMIN-only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, SC.updateSettings)).toEqual(['SUPER_ADMIN']);
    expect(admits(SettingsController, SC.updateSettings, 'SUPER_ADMIN')).toBe(true);
    for (const role of ALL_ROLES.filter((r) => r !== 'SUPER_ADMIN')) {
      expect({ role, admitted: admits(SettingsController, SC.updateSettings, role) }).toEqual({
        role,
        admitted: false,
      });
    }
  });

  it('ADMIN is refused the mutation — the exact defect #166 named', () => {
    expect(admits(SettingsController, SC.updateSettings, 'ADMIN')).toBe(false);
  });

  it('ORGANIZATION_MANAGER is refused the mutation, and is NOT granted read either', () => {
    // Deliberate. `settings` is a GLOBAL platform singleton with no tenant
    // column; ADR 014 grants ORGANIZATION_MANAGER authority INSIDE its own
    // organization and reserves platform settings to SUPER_ADMIN. Adding the
    // role here to satisfy a symmetry expectation would grant platform access
    // the contract withholds, so it is deliberately absent. Organization-owned
    // billing/settings ownership is #199, assigned elsewhere by the roadmap.
    expect(admits(SettingsController, SC.updateSettings, 'ORGANIZATION_MANAGER')).toBe(false);
    expect(admits(SettingsController, SC.getSettings, 'ORGANIZATION_MANAGER')).toBe(false);
    expect(admits(SettingsController, SC.announcement, 'ORGANIZATION_MANAGER')).toBe(false);
  });

  it('a method list REPLACES the class list — proven, not assumed', () => {
    class Probe {}
    Reflect.defineMetadata(ROLES_KEY, ['ADMIN'], Probe);
    const narrow = () => undefined;
    Reflect.defineMetadata(ROLES_KEY, ['SUPER_ADMIN'], narrow);
    expect(admits(Probe, narrow, 'ADMIN')).toBe(false); // the class list did NOT survive
    expect(admits(Probe, narrow, 'SUPER_ADMIN')).toBe(true);
  });

  it('an ABSENT list admits every authenticated role — why each route must carry one', () => {
    class Probe {}
    const bare = () => undefined;
    for (const role of ALL_ROLES) expect(admits(Probe, bare, role)).toBe(true);
  });

  it('no organization context is fabricated for the global singleton', () => {
    // The handlers take no scope and the service takes no organization: the row
    // is `singletonKey: 'global'`, and inventing a tenant for it would be
    // inventing ownership the model does not have.
    expect(SC.getSettings.length).toBe(0);
    expect(SC.announcement.length).toBe(0);
  });
});

describe('#165 [P2-02] dashboard metrics leak; admin sees global metrics', () => {
  const MC = DashboardMetricsController.prototype;

  it('metrics are UN-NARROWED organization authority only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MC.getMetrics)).toEqual(['SUPER_ADMIN', 'ORGANIZATION_MANAGER']);
  });

  it('ADMIN is refused — the exact defect #165 named', () => {
    expect(admits(DashboardMetricsController, MC.getMetrics, 'ADMIN')).toBe(false);
  });

  it('EDITOR and VIEWER are refused too', () => {
    for (const role of ['EDITOR', 'VIEWER']) {
      expect(admits(DashboardMetricsController, MC.getMetrics, role)).toBe(false);
    }
  });
});
