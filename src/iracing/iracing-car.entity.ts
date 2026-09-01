import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** A local cache of iRacing's car catalog (from the Data API's /car/get), refreshed by an
 * admin via the "Sync from iRacing" action — see IracingCarsService. This is public reference
 * data (not tied to any member), so it's safe to cache indefinitely between syncs. */
@Entity('iracing_cars')
export class IracingCar {
  /** iRacing's own car_id — used directly as our PK since it's already a stable identifier. */
  @PrimaryColumn({ name: 'car_id' })
  carId: number;

  @Column({ name: 'car_name' })
  carName: string;

  @Column({ name: 'car_name_abbreviated', type: 'varchar', nullable: true })
  carNameAbbreviated: string | null;

  @Column({ name: 'car_make', type: 'varchar', nullable: true })
  carMake: string | null;

  @Column({ name: 'car_model', type: 'varchar', nullable: true })
  carModel: string | null;

  /** Comma-joined, e.g. "sports_car" — matches the convention used elsewhere in this app
   * (DriverProfile.preferredClasses, Car.carClass) for simple free-text class fields. */
  @Column({ type: 'varchar', nullable: true })
  categories: string | null;

  @Column({ default: false })
  retired: boolean;

  /** Raw filenames from iRacing's /car/assets — not full URLs, and not full paths either: they
   * must be joined with `folder` below, then prefixed with IRACING_IMAGE_BASE_URL, to form a
   * real image URL. See IracingCarsService.withResolvedImages(). */
  @Column({ name: 'small_image', type: 'varchar', nullable: true })
  smallImage: string | null;

  @Column({ type: 'varchar', nullable: true })
  logo: string | null;

  /** The per-car asset folder small_image/logo live in — required to resolve a real URL. */
  @Column({ type: 'varchar', nullable: true })
  folder: string | null;

  @UpdateDateColumn({ name: 'synced_at', type: 'timestamptz' })
  syncedAt: Date;
}
