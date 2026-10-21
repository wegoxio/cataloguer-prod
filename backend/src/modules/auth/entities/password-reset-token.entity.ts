import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { User } from '../../users/entities/user.entity';

/**
 * Single-use password reset token (manual 5.5). Only the SHA-256 hash of
 * the emailed token is stored; expires after 45 minutes.
 */
@Entity({ tableName: 'password_reset_tokens' })
export class PasswordResetToken {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => User)
  user!: User;

  @Property({ unique: true, hidden: true })
  tokenHash!: string;

  @Property()
  expiresAt!: Date;

  @Property({ nullable: true })
  usedAt?: Date;

  @Property()
  createdAt: Date = new Date();
}
