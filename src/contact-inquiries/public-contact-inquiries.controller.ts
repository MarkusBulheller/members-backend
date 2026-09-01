import { Controller, Post, Body } from '@nestjs/common';
import { ContactInquiriesService } from './contact-inquiries.service.js';
import { CreateContactInquiryDto } from './dto/create-contact-inquiry.dto.js';

/** Deliberately unguarded — same rationale as the other Public*Controllers: the separate,
 * anonymous public marketing site's "Join the Grid" form has no login of its own, so this is the
 * one write it's allowed to make. Returns nothing but a 201 — the submitter never gets back
 * anything more than "it was received", same as the form's own optimistic success state. */
@Controller('contact-inquiries')
export class PublicContactInquiriesController {
  constructor(private readonly contactInquiriesService: ContactInquiriesService) {}

  @Post()
  async create(@Body() dto: CreateContactInquiryDto): Promise<void> {
    await this.contactInquiriesService.create(dto);
  }
}
