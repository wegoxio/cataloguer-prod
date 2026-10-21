import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { ImportConcurrencySemaphore } from './import-concurrency.semaphore';
import { ImportConcurrencyGuard } from './import-concurrency.guard';
import { IMPORT_CONCURRENCY_SEMAPHORE } from './import-upload.constants';
import { MULTIPART_LIMITS } from '../../../common/http/body-limits';

/**
 * Domain-owned security for the two CSV import routes (#172). It owns, in one
 * place:
 *  - the Multer byte limit, sourced from the validated ConfigService at DI
 *    time (never a decorator-time process.env read);
 *  - the SINGLE per-container concurrency semaphore;
 *  - the ImportConcurrencyGuard.
 *
 * ImportsModule and SuppliersModule both import THIS module, so both routes
 * receive the same byte limit and share one semaphore instance. Nest resolves
 * the exported providers once, so importing it from two feature modules does
 * not create duplicates. This is deliberately scoped to imports — not a
 * general upload framework.
 */
@Module({
  imports: [
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        limits: {
          fileSize: config.get<number>('MAX_IMPORT_FILE_BYTES'),
          // Only fileSize and files were bounded before Phase 9, leaving
          // `parts` and `fields` at Infinity: a multipart body carrying tens of
          // thousands of non-file parts was bounded only by part count times
          // multer's 1 MB default fieldSize. These routes read one file and a
          // handful of scalars, so the honest limits are small.
          ...MULTIPART_LIMITS,
        },
      }),
    }),
  ],
  providers: [
    {
      provide: IMPORT_CONCURRENCY_SEMAPHORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new ImportConcurrencySemaphore(config.get<number>('IMPORT_CONCURRENCY_PERMITS') as number),
    },
    ImportConcurrencyGuard,
  ],
  exports: [MulterModule, ImportConcurrencyGuard, IMPORT_CONCURRENCY_SEMAPHORE],
})
export class ImportUploadSecurityModule {}
