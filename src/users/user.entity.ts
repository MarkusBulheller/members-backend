import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  JoinColumn,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { Role } from '../common/enums/role.enum.js';
import { UserStatus } from '../common/enums/user-status.enum.js';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ name: 'discord_id', unique: true })
  discordId: string;

  @Column({ name: 'discord_username' })
  discordUsername: string;

  @Column({ name: 'discord_global_name', type: 'varchar', nullable: true })
  discordGlobalName: string | null;

  @Column({ name: 'discord_avatar_url', type: 'varchar', nullable: true })
  discordAvatarUrl: string | null;

  @Column({ type: 'enum', enum: Role, default: Role.MEMBER })
  role: Role;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.PENDING })
  status: UserStatus;

  @Column({ name: 'token_version', default: 0 })
  tokenVersion: number;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'approved_by_user_id' })
  approvedBy: Relation<User> | null;

  @Column({ name: 'approved_by_user_id', type: 'uuid', nullable: true })
  approvedByUserId: string | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ name: 'rejection_reason', type: 'varchar', nullable: true })
  rejectionReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
