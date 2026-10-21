import { Seeder } from '@mikro-orm/seeder';
import { EntityManager } from '@mikro-orm/core';
import { Role } from '../../modules/users/entities/role.entity';
import { User } from '../../modules/users/entities/user.entity';
import { canonicalEmail, canonicalEmailKey } from '../../modules/users/identity/email-identity';
import * as argon2 from 'argon2';

export class DatabaseSeeder extends Seeder {
  async run(em: EntityManager): Promise<void> {
    const rolesToCreate = ['SUPER_ADMIN', 'ADMIN', 'EDITOR', 'VIEWER'];
    const rolesMap: Record<string, Role> = {};

    for (const roleName of rolesToCreate) {
      let role = await em.findOne(Role, { name: roleName });
      if (!role) {
        role = em.create(Role, { name: roleName });
        await em.persistAndFlush(role);
      }
      rolesMap[roleName] = role;
    }

    const isProd = process.env.NODE_ENV === 'production';
    const devAdminEmail = process.env.DEV_ADMIN_EMAIL;
    const devAdminPassword = process.env.DEV_ADMIN_PASSWORD;

    if (isProd) {
      console.log('Production environment detected. Skipping development admin user seeding.');
      return;
    }

    if (!devAdminEmail || !devAdminPassword) {
      console.log(
        'Development admin credentials (DEV_ADMIN_EMAIL / DEV_ADMIN_PASSWORD) not defined. Skipping user seeding.',
      );
      return;
    }

    // The same identity rule every other creation path follows (#291), so a
    // DEV_ADMIN_EMAIL with a capital letter cannot seed an account whose owner
    // is then unable to sign in with what they typed.
    const email = canonicalEmail(devAdminEmail);
    const existingAdmin = await em.findOne(User, { [canonicalEmailKey()]: email } as never);
    if (!existingAdmin) {
      const passwordHash = await argon2.hash(devAdminPassword);
      const superAdminUser = em.create(User, {
        email,
        passwordHash,
        role: rolesMap['SUPER_ADMIN'],
      });
      await em.persistAndFlush(superAdminUser);
      console.log(`Default Development Super Admin created: ${email}`);
    }
  }
}
