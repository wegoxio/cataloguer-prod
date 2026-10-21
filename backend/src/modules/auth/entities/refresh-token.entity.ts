import { Entity, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { User } from '../../users/entities/user.entity';

/**
 * Server-side record of an issued refresh token (manual 5.1: rotation).
 * The id doubles as the JWT `jti` claim; only a SHA-256 hash of the
 * signed token is stored, never the token itself.
 */
@Entity({ tableName: 'refresh_tokens' })
export class RefreshToken {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Index()
  @ManyToOne(() => User)
  user!: User;

  @Property({ hidden: true })
  tokenHash!: string;

  @Property()
  expiresAt!: Date;

  @Property({ nullable: true })
  revokedAt?: Date;

  @Property({ type: 'uuid', nullable: true })
  replacedById?: string;

  // Device context shown in the sessions list
  @Property({ nullable: true })
  ip?: string;

  @Property({ nullable: true })
  userAgent?: string;

  @Property()
  createdAt?: Date = new Date();
}
