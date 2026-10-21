import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Store } from './entities/store.entity';
import { StoresService } from './stores.service';
import { StoresController } from './stores.controller';
import { AuthModule } from '../auth/auth.module';
import { PublicationGuardService } from '../products/publication/publication-guard.service';
import { UsersModule } from '../users/users.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { StorageModule } from '../storage/storage.module';

// Registers `store` with the recovery registry at module load (#293), exactly
// as items, categories and users do. Imported for its side effect.

@Module({
  imports: [MikroOrmModule.forFeature([Store]), AuthModule, UsersModule, AuditLogModule, StorageModule],
  controllers: [StoresController],
  // The guard is stateless and is provided wherever a writer needs it (as in
  // `ImportsModule`): a restored store has cards to take with it (#342).
  providers: [StoresService, PublicationGuardService],
  // `StoreRemovalService` is exported so `RecoveryModule` can bind its restore
  // handler in one place, in order, the way every other slice's is bound.
  exports: [StoresService],
})
export class StoresModule {}
