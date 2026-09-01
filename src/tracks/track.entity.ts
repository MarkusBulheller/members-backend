import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('tracks')
export class Track {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  /** Free text, e.g. "road" / "oval" / "dirt_road" / "dirt_oval" — mirrors Car.carClass. */
  @Column()
  category: string;

  @Column({ type: 'varchar', nullable: true })
  location: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  /** The iRacing track image, captured when this track was created via the "Pick from
   * iRacing" picker (see TrackFormPage) — a full CDN URL. */
  @Column({ name: 'image_url', type: 'varchar', nullable: true })
  imageUrl: string | null;

  /** Soft-delete flag — see the equivalent comment on the Car entity. */
  @Column({ default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
