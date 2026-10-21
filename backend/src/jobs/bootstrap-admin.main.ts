import { MikroORM } from '@mikro-orm/postgresql';
import * as argon2 from 'argon2';
import databaseConfig from '../database/mikro-orm.config';
import { Role } from '../modules/users/entities/role.entity';
import { User } from '../modules/users/entities/user.entity';
import { canonicalEmail, canonicalEmailKey } from '../modules/users/identity/email-identity';

const ROLE_NAMES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN', 'EDITOR', 'VIEWER'] as const;

async function bootstrapAdmin(): Promise<void> {
  const inputEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!inputEmail || !password) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are required.');
  }
  if (password.length < 14) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must contain at least 14 characters.');
  }

  const email = canonicalEmail(inputEmail);
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL is not a valid email address.');
  }

  const orm = await MikroORM.init(databaseConfig);
  const em = orm.em.fork();

  try {
    const roles = new Map<string, Role>();
    for (const name of ROLE_NAMES) {
      let role = await em.findOne(Role, { name });
      if (!role) {
        role = em.create(Role, { name });
        em.persist(role);
      }
      roles.set(name, role);
    }
    await em.flush();

    const existingForEmail = await em.findOne(User, { [canonicalEmailKey()]: email } as never, {
      populate: ['role'],
      filters: false,
    });
    if (existingForEmail) {
      if (existingForEmail.role.name !== 'SUPER_ADMIN' || existingForEmail.removedAt) {
        throw new Error(`The address ${email} is already assigned to a non-active-superadmin identity.`);
      }
      console.log(`Superadmin ${email} already exists; no changes made.`);
      return;
    }

    const existingSuperAdmin = await em.findOne(User, { role: roles.get('SUPER_ADMIN')! }, { filters: false });
    if (existingSuperAdmin) {
      throw new Error(
        'A SUPER_ADMIN already exists. Refusing to create a second platform owner through the bootstrap command.',
      );
    }

    const user = em.create(User, {
      email,
      passwordHash: await argon2.hash(password),
      role: roles.get('SUPER_ADMIN')!,
      termsAcceptedAt: new Date(),
    });
    await em.persistAndFlush(user);
    console.log(`Production superadmin created: ${email}`);
  } finally {
    await orm.close(true);
  }
}

bootstrapAdmin().catch((error: unknown) => {
  console.error('Production superadmin bootstrap failed.', error);
  process.exitCode = 1;
});
