import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const CONTACT_INQUIRY_INTERESTS = ['Driver Seat', 'Sponsorship', 'Content / Media', 'Just Following'] as const;
export type ContactInquiryInterest = (typeof CONTACT_INQUIRY_INTERESTS)[number];

/** One "Join the Grid" submission from the public marketing site's contact form — see
 * PublicContactInquiriesController for the unguarded submit endpoint and
 * ContactInquiriesController for the admin-only review list. */
@Entity('contact_inquiries')
export class ContactInquiry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column()
  email: string;

  /** Only meaningful (and only ever collected by the form) when interestedIn is "Driver Seat" —
   * null otherwise, not an empty string, so a reviewer can tell "not asked" from "left blank". */
  @Column({ name: 'iracing_id', type: 'varchar', nullable: true })
  iracingId: string | null;

  @Column({ name: 'interested_in' })
  interestedIn: string;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  /** Admin triage flag — whether someone's already followed up on this, not a data-processing
   * status. Defaults false so new submissions surface first in the review list. */
  @Column({ default: false })
  reviewed: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
