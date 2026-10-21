import { MikroORM } from '@mikro-orm/postgresql';
import databaseConfig from '../database/mikro-orm.config';

async function migrate(): Promise<void> {
  const orm = await MikroORM.init(databaseConfig);

  try {
    const pending = await orm.getMigrator().getPendingMigrations();
    if (pending.length === 0) {
      console.log('Database schema is already current.');
      return;
    }

    console.log(`Applying ${pending.length} pending migration(s)...`);
    await orm.getMigrator().up();
    console.log('Database migrations completed successfully.');
  } finally {
    await orm.close(true);
  }
}

migrate().catch((error: unknown) => {
  console.error('Database migration failed.', error);
  process.exitCode = 1;
});
