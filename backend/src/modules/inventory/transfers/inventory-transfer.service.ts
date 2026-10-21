import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { InventoryPostingService } from '../ledger/inventory-posting.service';
import { InventoryCommand, InventoryPrincipal, PhysicalCondition } from '../ledger/inventory.types';

interface TransferLineRow {
  id: string;
  product_id: string;
  physical_condition: PhysicalCondition;
  quantity: number;
  dispatched_quantity: number;
  received_quantity: number;
  returning_quantity: number;
  returned_quantity: number;
}

/**
 * P5-B5 — moving custody between an organization's own locations (Decision 4).
 *
 * Four movements, each a balanced command, so the organization total never
 * changes and only the location does:
 *
 *   commit   AVAILABLE(source)          -> TRANSFER_COMMITTED(source)
 *   dispatch TRANSFER_COMMITTED(source) -> IN_TRANSIT(transfer, DISPATCH)
 *   receive  IN_TRANSIT(DISPATCH)       -> AVAILABLE(destination)
 *   return   IN_TRANSIT(DISPATCH)       -> IN_TRANSIT(transfer, RETURN)
 *            IN_TRANSIT(RETURN)         -> AVAILABLE(source)
 *
 * Committing first is what makes a transfer honest: the units stop being
 * sellable at the source the moment somebody decides to move them, not when
 * they physically leave.
 */
@Injectable()
export class InventoryTransferService {
  constructor(private readonly posting: InventoryPostingService) {}

  private async sequence(em: EntityManager, organizationId: string, prefix: string): Promise<number> {
    const rows: { n: number }[] = await em.execute(
      `select count(*)::int as n from inventory_transactions where organization_id = ? and idempotency_key like ?`,
      [organizationId, `${prefix}%`],
    );
    return rows[0]?.n ?? 0;
  }

  /** Every transfer movement is the same shape: one product, out of one cell and into another. */
  private async move(
    em: EntityManager,
    params: {
      organizationId: string;
      type: 'TRANSFER_COMMIT' | 'TRANSFER_DISPATCH' | 'TRANSFER_RECEIVE' | 'TRANSFER_RETURN';
      transferId: string;
      productId: string;
      physicalCondition: PhysicalCondition;
      quantity: number;
      principal: InventoryPrincipal;
      from: { locationId: string | null; state: string; direction?: 'DISPATCH' | 'RETURN' };
      to: { locationId: string | null; state: string; direction?: 'DISPATCH' | 'RETURN' };
    },
  ): Promise<string> {
    const prefix = `transfer:${params.transferId}:${params.type}:${params.productId}:`;
    const seq = await this.sequence(em, params.organizationId, prefix);
    const line = (
      side: { locationId: string | null; state: string; direction?: 'DISPATCH' | 'RETURN' },
      sign: 1 | -1,
    ) => ({
      productId: params.productId,
      locationId: side.locationId,
      physicalCondition: params.physicalCondition,
      operationalState: side.state as any,
      transferId: side.state === 'IN_TRANSIT' ? params.transferId : null,
      transitDirection: side.state === 'IN_TRANSIT' ? (side.direction ?? 'DISPATCH') : null,
      quantityDelta: sign * params.quantity,
    });
    const command: InventoryCommand = {
      organizationId: params.organizationId,
      type: params.type,
      idempotencyKey: `${prefix}${seq}`,
      principal: params.principal,
      transferId: params.transferId,
      intents: [{ productId: params.productId, declaredAmount: params.quantity, intentSign: 0 }],
      movements: [line(params.from, -1), line(params.to, 1)],
    };
    const posted = await this.posting.postWithin(em, command);
    return posted.transactionId;
  }

  async createDraft(
    em: EntityManager,
    params: {
      organizationId: string;
      sourceLocationId: string;
      destinationLocationId: string;
      lines: { productId: string; quantity: number; physicalCondition?: PhysicalCondition }[];
      reference?: string | null;
      actorUserId?: string | null;
    },
  ): Promise<string> {
    if (params.sourceLocationId === params.destinationLocationId) {
      throw new BadRequestException('A transfer needs two different locations');
    }
    if (!params.lines.length) throw new BadRequestException('A transfer needs at least one line');
    const [transfer]: { id: string }[] = await em.execute(
      `insert into inventory_transfers
         (organization_id, source_location_id, destination_location_id, status, reference, actor_user_id, created_at, updated_at)
       values (?, ?::uuid, ?::uuid, 'DRAFT', ?, ?::uuid, now(), now()) returning id`,
      [
        params.organizationId,
        params.sourceLocationId,
        params.destinationLocationId,
        params.reference ?? null,
        params.actorUserId ?? null,
      ],
    );
    for (const line of params.lines) {
      if (line.quantity <= 0) throw new BadRequestException('A transfer line needs a positive quantity');
      await em.execute(
        `insert into inventory_transfer_lines
           (organization_id, transfer_id, product_id, physical_condition, quantity)
         values (?, ?::uuid, ?::uuid, ?, ?)`,
        [params.organizationId, transfer.id, line.productId, line.physicalCondition ?? 'GOOD', line.quantity],
      );
    }
    return transfer.id;
  }

  private async load(em: EntityManager, organizationId: string, transferId: string) {
    const rows: { id: string; status: string; source_location_id: string; destination_location_id: string }[] =
      await em.execute(
        `select id, status, source_location_id, destination_location_id
           from inventory_transfers where id = ?::uuid and organization_id = ?`,
        [transferId, organizationId],
      );
    if (!rows[0]) throw new NotFoundException('Transfer not found');
    const lines: TransferLineRow[] = await em.execute(
      `select id, product_id, physical_condition, quantity, dispatched_quantity, received_quantity,
              returning_quantity, returned_quantity
         from inventory_transfer_lines where transfer_id = ?::uuid order by product_id`,
      [transferId],
    );
    return { ...rows[0], lines };
  }

  private async setStatus(em: EntityManager, transferId: string, status: string): Promise<void> {
    await em.execute(`update inventory_transfers set status = ?, updated_at = now() where id = ?::uuid`, [
      status,
      transferId,
    ]);
  }

  /** Reserves the units for the journey: they stop being sellable at the source. */
  async commit(
    em: EntityManager,
    params: { organizationId: string; transferId: string; principal: InventoryPrincipal },
  ): Promise<void> {
    const transfer = await this.load(em, params.organizationId, params.transferId);
    if (transfer.status !== 'DRAFT') throw new BadRequestException(`A ${transfer.status} transfer cannot be committed`);
    for (const line of transfer.lines) {
      await this.move(em, {
        organizationId: params.organizationId,
        type: 'TRANSFER_COMMIT',
        transferId: params.transferId,
        productId: line.product_id,
        physicalCondition: line.physical_condition,
        quantity: line.quantity,
        principal: params.principal,
        from: { locationId: transfer.source_location_id, state: 'AVAILABLE' },
        to: { locationId: transfer.source_location_id, state: 'TRANSFER_COMMITTED' },
      });
    }
    await this.setStatus(em, params.transferId, 'COMMITTED');
  }

  /** The units leave: owned by the organization, present at no location. */
  async dispatch(
    em: EntityManager,
    params: {
      organizationId: string;
      transferId: string;
      principal: InventoryPrincipal;
      quantities?: Record<string, number>;
    },
  ): Promise<void> {
    const transfer = await this.load(em, params.organizationId, params.transferId);
    if (!['COMMITTED', 'IN_TRANSIT'].includes(transfer.status)) {
      throw new BadRequestException(`A ${transfer.status} transfer cannot dispatch`);
    }
    for (const line of transfer.lines) {
      const outstanding = line.quantity - line.dispatched_quantity;
      const quantity = params.quantities?.[line.product_id] ?? outstanding;
      if (quantity <= 0) continue;
      if (quantity > outstanding) {
        throw new BadRequestException('A transfer cannot dispatch more than it planned');
      }
      await this.move(em, {
        organizationId: params.organizationId,
        type: 'TRANSFER_DISPATCH',
        transferId: params.transferId,
        productId: line.product_id,
        physicalCondition: line.physical_condition,
        quantity,
        principal: params.principal,
        from: { locationId: transfer.source_location_id, state: 'TRANSFER_COMMITTED' },
        to: { locationId: null, state: 'IN_TRANSIT', direction: 'DISPATCH' },
      });
      await em.execute(
        `update inventory_transfer_lines set dispatched_quantity = dispatched_quantity + ? where id = ?::uuid`,
        [quantity, line.id],
      );
    }
    await this.setStatus(em, params.transferId, 'IN_TRANSIT');
  }

  /** Arrival, partial or complete. */
  async receive(
    em: EntityManager,
    params: {
      organizationId: string;
      transferId: string;
      principal: InventoryPrincipal;
      quantities?: Record<string, number>;
    },
  ): Promise<void> {
    const transfer = await this.load(em, params.organizationId, params.transferId);
    if (!['IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RETURNING'].includes(transfer.status)) {
      throw new BadRequestException(`A ${transfer.status} transfer cannot receive`);
    }
    for (const line of transfer.lines) {
      const travelling = line.dispatched_quantity - line.received_quantity - line.returning_quantity;
      const quantity = params.quantities?.[line.product_id] ?? travelling;
      if (quantity <= 0) continue;
      if (quantity > travelling) throw new BadRequestException('A transfer cannot receive more than is travelling');
      await this.move(em, {
        organizationId: params.organizationId,
        type: 'TRANSFER_RECEIVE',
        transferId: params.transferId,
        productId: line.product_id,
        physicalCondition: line.physical_condition,
        quantity,
        principal: params.principal,
        from: { locationId: null, state: 'IN_TRANSIT', direction: 'DISPATCH' },
        to: { locationId: transfer.destination_location_id, state: 'AVAILABLE' },
      });
      await em.execute(
        `update inventory_transfer_lines set received_quantity = received_quantity + ? where id = ?::uuid`,
        [quantity, line.id],
      );
    }
    const after = await this.load(em, params.organizationId, params.transferId);
    const settled = after.lines.every(
      (line) =>
        line.received_quantity + line.returned_quantity >= line.dispatched_quantity &&
        line.dispatched_quantity === line.quantity,
    );
    await this.setStatus(em, params.transferId, settled ? 'COMPLETED' : 'PARTIALLY_RECEIVED');
  }

  /** Units that will not arrive start travelling home. */
  async startReturn(
    em: EntityManager,
    params: {
      organizationId: string;
      transferId: string;
      principal: InventoryPrincipal;
      quantities?: Record<string, number>;
    },
  ): Promise<void> {
    const transfer = await this.load(em, params.organizationId, params.transferId);
    for (const line of transfer.lines) {
      const travelling = line.dispatched_quantity - line.received_quantity - line.returning_quantity;
      const quantity = params.quantities?.[line.product_id] ?? travelling;
      if (quantity <= 0) continue;
      if (quantity > travelling) throw new BadRequestException('A transfer cannot return more than is travelling');
      await this.move(em, {
        organizationId: params.organizationId,
        type: 'TRANSFER_RETURN',
        transferId: params.transferId,
        productId: line.product_id,
        physicalCondition: line.physical_condition,
        quantity,
        principal: params.principal,
        from: { locationId: null, state: 'IN_TRANSIT', direction: 'DISPATCH' },
        to: { locationId: null, state: 'IN_TRANSIT', direction: 'RETURN' },
      });
      await em.execute(
        `update inventory_transfer_lines set returning_quantity = returning_quantity + ? where id = ?::uuid`,
        [quantity, line.id],
      );
    }
    await this.setStatus(em, params.transferId, 'RETURNING');
  }

  /** They arrive home. */
  async completeReturn(
    em: EntityManager,
    params: { organizationId: string; transferId: string; principal: InventoryPrincipal },
  ): Promise<void> {
    const transfer = await this.load(em, params.organizationId, params.transferId);
    for (const line of transfer.lines) {
      const quantity = line.returning_quantity - line.returned_quantity;
      if (quantity <= 0) continue;
      await this.move(em, {
        organizationId: params.organizationId,
        type: 'TRANSFER_RETURN',
        transferId: params.transferId,
        productId: line.product_id,
        physicalCondition: line.physical_condition,
        quantity,
        principal: params.principal,
        from: { locationId: null, state: 'IN_TRANSIT', direction: 'RETURN' },
        to: { locationId: transfer.source_location_id, state: 'AVAILABLE' },
      });
      await em.execute(
        `update inventory_transfer_lines set returned_quantity = returned_quantity + ? where id = ?::uuid`,
        [quantity, line.id],
      );
    }
    const after = await this.load(em, params.organizationId, params.transferId);
    const settled = after.lines.every(
      (line) => line.received_quantity + line.returned_quantity >= line.dispatched_quantity,
    );
    await this.setStatus(em, params.transferId, settled ? 'COMPLETED' : 'PARTIALLY_RECEIVED');
  }

  /** A transfer that has not left can be called off; committed units go back. */
  async cancel(
    em: EntityManager,
    params: { organizationId: string; transferId: string; principal: InventoryPrincipal },
  ): Promise<void> {
    const transfer = await this.load(em, params.organizationId, params.transferId);
    if (!['DRAFT', 'COMMITTED'].includes(transfer.status)) {
      throw new BadRequestException(`A ${transfer.status} transfer cannot be cancelled; return it instead`);
    }
    if (transfer.status === 'COMMITTED') {
      for (const line of transfer.lines) {
        await this.move(em, {
          organizationId: params.organizationId,
          type: 'TRANSFER_COMMIT',
          transferId: params.transferId,
          productId: line.product_id,
          physicalCondition: line.physical_condition,
          quantity: line.quantity,
          principal: params.principal,
          from: { locationId: transfer.source_location_id, state: 'TRANSFER_COMMITTED' },
          to: { locationId: transfer.source_location_id, state: 'AVAILABLE' },
        });
      }
    }
    await this.setStatus(em, params.transferId, 'CANCELLED');
  }
}
