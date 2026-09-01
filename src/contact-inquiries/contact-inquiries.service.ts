import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ContactInquiry } from './contact-inquiry.entity.js';
import { CreateContactInquiryDto } from './dto/create-contact-inquiry.dto.js';

@Injectable()
export class ContactInquiriesService {
  constructor(
    @InjectRepository(ContactInquiry)
    private readonly inquiriesRepository: Repository<ContactInquiry>,
  ) {}

  create(dto: CreateContactInquiryDto): Promise<ContactInquiry> {
    const inquiry = this.inquiriesRepository.create({
      name: dto.name,
      email: dto.email,
      iracingId: dto.iracingId ?? null,
      interestedIn: dto.interestedIn,
      message: dto.message ?? null,
    });
    return this.inquiriesRepository.save(inquiry);
  }

  // Newest first, unreviewed first — an admin working the list should see what still needs a
  // reply before older, already-handled entries.
  list(): Promise<ContactInquiry[]> {
    return this.inquiriesRepository.find({ order: { reviewed: 'ASC', createdAt: 'DESC' } });
  }

  async setReviewed(id: string, reviewed: boolean): Promise<ContactInquiry> {
    const inquiry = await this.inquiriesRepository.findOne({ where: { id } });
    if (!inquiry) {
      throw new NotFoundException('Inquiry not found');
    }
    inquiry.reviewed = reviewed;
    return this.inquiriesRepository.save(inquiry);
  }

  async remove(id: string): Promise<void> {
    const result = await this.inquiriesRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException('Inquiry not found');
    }
  }
}
