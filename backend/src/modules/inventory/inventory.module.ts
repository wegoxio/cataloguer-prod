import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { InventoryLocation } from './entities/inventory-location.entity';
import { InventoryTransaction } from './entities/inventory-transaction.entity';
import { InventoryTransactionIntent } from './entities/inventory-transaction-intent.entity';
import { InventoryEntry } from './entities/inventory-entry.entity';
import { InventoryBalance } from './entities/inventory-balance.entity';
import { InventoryTransitBalance } from './entities/inventory-transit-balance.entity';
import { InventoryOpeningReconciliation } from './entities/inventory-opening-reconciliation.entity';
import { InventoryOpeningReconciliationAllocation } from './entities/inventory-opening-reconciliation-allocation.entity';
import { InventoryReservation } from './entities/inventory-reservation.entity';
import { InventoryBackorder } from './entities/inventory-backorder.entity';
import { InventoryBackorderAllocation } from './entities/inventory-backorder-allocation.entity';
import { InventoryTransfer } from './entities/inventory-transfer.entity';
import { InventoryTransferLine } from './entities/inventory-transfer-line.entity';
import { InventoryPostingService } from './ledger/inventory-posting.service';
import { InventoryReconciliationService } from './ledger/inventory-reconciliation.service';
import { InventoryOpeningProposalService } from './opening/inventory-opening-proposal.service';
import { InventoryOpeningService } from './opening/inventory-opening.service';
import { InventoryStockService } from './ledger/inventory-stock.service';
import { InventoryReservationService } from './reservations/inventory-reservation.service';
import { InventoryTransferService } from './transfers/inventory-transfer.service';
import { InventoryCommandService } from './ledger/inventory-command.service';
import { InventoryController } from './inventory.controller';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditLog } from '../audit-log/entities/audit-log.entity';

/**
 * P5-B1 shipped providers ONLY, deliberately: the posting mechanism existed and
 * was proved, but who may call it — and for which workflow — was left to the
 * boundaries that converted the legacy writers, and the administration UX was
 * named as Phase 8 work (ADR 013 §20: "No HTTP routes were added").
 *
 * Phase 8 adds that surface, and only that: `InventoryController` exposes
 * BOUNDED DOMAIN COMMANDS (recount, reclassify, reassign, distribute,
 * transfers) and the reads an operator needs. There is no generic
 * ledger-posting route, and nothing reaches the compatibility caches except
 * through the classified posting mechanism these services already use.
 */
@Module({
  imports: [
    // The controller is guarded, and a guard needs its collaborators in scope:
    // JwtAuthGuard resolves the session through JwtService and re-reads the
    // user and tenant scope on every request. Without these the container
    // cannot build the guard and the application refuses to boot.
    AuthModule,
    UsersModule,
    MikroOrmModule.forFeature([
      InventoryLocation,
      InventoryTransaction,
      InventoryTransactionIntent,
      InventoryEntry,
      InventoryBalance,
      InventoryTransitBalance,
      InventoryOpeningReconciliation,
      InventoryOpeningReconciliationAllocation,
      InventoryReservation,
      InventoryBackorder,
      InventoryBackorderAllocation,
      InventoryTransfer,
      InventoryTransferLine,
      AuditLog,
    ]),
  ],
  controllers: [InventoryController],
  providers: [
    InventoryPostingService,
    InventoryReconciliationService,
    InventoryOpeningProposalService,
    InventoryOpeningService,
    InventoryStockService,
    InventoryReservationService,
    InventoryTransferService,
    InventoryCommandService,
    AuditLogService,
  ],
  exports: [
    InventoryPostingService,
    InventoryReconciliationService,
    InventoryOpeningProposalService,
    InventoryOpeningService,
    InventoryStockService,
    InventoryReservationService,
    InventoryTransferService,
    InventoryCommandService,
    AuditLogService,
  ],
})
export class InventoryModule {}
