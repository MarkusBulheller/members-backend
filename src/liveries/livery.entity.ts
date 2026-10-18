import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { Car } from '../cars/car.entity.js';

@Entity('liveries')
export class Livery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Car, (car) => car.liveries, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'car_id' })
  car: Relation<Car>;

  @Index('idx_liveries_car_id')
  @Column({ name: 'car_id' })
  carId: string;

  @Column({ name: 'image_url' })
  imageUrl: string;

  @Column()
  name: string;

  /** Plain column, not a relation to User — keeps Liveries decoupled from the Users module. */
  @Column({ name: 'uploaded_by_user_id' })
  uploadedByUserId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** Not a column — display name of the uploader, resolved at read time by CarsService (driver
   * profile display name, falling back to the Discord name). Null when the uploader is gone. */
  uploadedByName?: string | null;
}
