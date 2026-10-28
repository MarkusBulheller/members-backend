import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

export type ResultAttemptStatus = 'FOUND' | 'IMPORTED' | 'FAILED' | 'IGNORED';

/** One session the automatic result import has noticed for one watched team — the work queue /
 * audit trail of IracingResultAutoImportService. Unique per (subsession, team); the result itself
 * lives in race_results once IMPORTED (raceResultId). Plain columns, no relations, so this stays
 * decoupled from the race-results module and survives a result being deleted. */
@Entity('iracing_result_attempts')
@Unique('uq_iracing_result_attempts_subsession_team', ['subsessionId', 'teamId'])
export class IracingResultAttempt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'subsession_id', type: 'int' })
  subsessionId: number;

  @Column({ name: 'team_id', type: 'int' })
  teamId: number;

  @Column({ name: 'series_name', type: 'varchar', nullable: true })
  seriesName: string | null;

  @Column({ name: 'track_name', type: 'varchar', nullable: true })
  trackName: string | null;

  @Column({ name: 'car_name', type: 'varchar', nullable: true })
  carName: string | null;

  @Column({ name: 'start_time', type: 'timestamptz', nullable: true })
  startTime: Date | null;

  @Column({ name: 'end_time', type: 'timestamptz', nullable: true })
  endTime: Date | null;

  @Column({ name: 'finishing_position_in_class', type: 'int', nullable: true })
  finishingPositionInClass: number | null;

  @Column({ name: 'finishing_position', type: 'int', nullable: true })
  finishingPosition: number | null;

  @Column({ name: 'laps_complete', type: 'int', nullable: true })
  lapsComplete: number | null;

  @Index('idx_iracing_result_attempts_status')
  @Column({ type: 'varchar', default: 'FOUND' })
  status: ResultAttemptStatus;

  @Column({ type: 'int', default: 0 })
  tries: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'race_result_id', type: 'uuid', nullable: true })
  raceResultId: string | null;

  /** When the "new result available" Discord message was posted (NOTIFY mode); null = not yet. */
  @Column({ name: 'announced_at', type: 'timestamptz', nullable: true })
  announcedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
