import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** One row per subsession the hourly car-usage scan has already tallied — lets scanSeason widen
 * its search window with a safety-margin overlap (see IracingCarUsageService.scanSeason) to cover
 * iRacing's indexing lag without double-counting a subsession it already processed. */
@Entity('iracing_car_usage_scanned_subsessions')
export class IracingCarUsageScannedSubsession {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ name: 'subsession_id', type: 'int' })
  @Index({ unique: true })
  subsessionId: number;

  @CreateDateColumn({ name: 'scanned_at', type: 'timestamptz' })
  scannedAt: Date;
}
