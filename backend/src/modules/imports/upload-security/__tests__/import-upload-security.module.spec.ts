import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { validate } from '../../../../config/env.validation';
import { ImportConcurrencySemaphore } from '../import-concurrency.semaphore';
import { ImportUploadSecurityModule } from '../import-upload-security.module';
import { IMPORT_CONCURRENCY_SEMAPHORE } from '../import-upload.constants';

/**
 * Proves the domain-owned security module wires the byte limit and semaphore
 * from validated config, and that two feature modules importing it share ONE
 * semaphore instance rather than each getting its own pool (#172).
 */

// Two stand-in feature modules, each re-exporting the shared security module —
// exactly how ImportsModule and SuppliersModule consume it.
@Module({ imports: [ImportUploadSecurityModule], exports: [ImportUploadSecurityModule] })
class FeatureAModule {}
@Module({ imports: [ImportUploadSecurityModule], exports: [ImportUploadSecurityModule] })
class FeatureBModule {}

const boot = async (env: Record<string, string>) => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://x',
    JWT_ACCESS_SECRET: 's',
    JWT_REFRESH_SECRET: 's',
    ...env,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, validate }), FeatureAModule, FeatureBModule],
  }).compile();
  process.env = saved;
  return moduleRef;
};

describe('ImportUploadSecurityModule', () => {
  it('applies the default permit count when unset', async () => {
    const moduleRef = await boot({});
    const semaphore = moduleRef.get<ImportConcurrencySemaphore>(IMPORT_CONCURRENCY_SEMAPHORE);
    expect(semaphore).toBeInstanceOf(ImportConcurrencySemaphore);
    expect(semaphore.free).toBe(4); // default
    await moduleRef.close();
  });

  it('honours an overridden permit count', async () => {
    const moduleRef = await boot({ IMPORT_CONCURRENCY_PERMITS: '2' });
    const semaphore = moduleRef.get<ImportConcurrencySemaphore>(IMPORT_CONCURRENCY_SEMAPHORE);
    expect(semaphore.free).toBe(2);
    await moduleRef.close();
  });

  it('sources the Multer byte limit from validated config, files capped at 1', async () => {
    const moduleRef = await boot({ MAX_IMPORT_FILE_BYTES: '1048576' });
    const options = moduleRef.get('MULTER_MODULE_OPTIONS');
    expect(options.limits.fileSize).toBe(1048576);
    expect(options.limits.files).toBe(1);
    await moduleRef.close();
  });

  it('defaults the Multer byte limit to 5 MiB', async () => {
    const moduleRef = await boot({});
    const options = moduleRef.get('MULTER_MODULE_OPTIONS');
    expect(options.limits.fileSize).toBe(5242880);
    await moduleRef.close();
  });

  it('shares a single semaphore instance across both feature modules', async () => {
    const moduleRef = await boot({});
    // Resolve from each feature module's own context; Nest must return the same
    // singleton, proving both import routes compete for one pool.
    const fromA = moduleRef.select(FeatureAModule).get<ImportConcurrencySemaphore>(IMPORT_CONCURRENCY_SEMAPHORE);
    const fromB = moduleRef.select(FeatureBModule).get<ImportConcurrencySemaphore>(IMPORT_CONCURRENCY_SEMAPHORE);
    expect(fromA).toBe(fromB);

    // And a permit taken via one view is visible through the other.
    fromA.tryAcquire();
    expect(fromB.free).toBe(3);
    await moduleRef.close();
  });
});
