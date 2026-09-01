import {
  Column,
  CreateDateColumn,
  Entity,
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
}
