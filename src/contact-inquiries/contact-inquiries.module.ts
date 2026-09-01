import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContactInquiriesController } from './contact-inquiries.controller.js';
import { ContactInquiriesService } from './contact-inquiries.service.js';
import { ContactInquiry } from './contact-inquiry.entity.js';
import { PublicContactInquiriesController } from './public-contact-inquiries.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([ContactInquiry])],
  controllers: [ContactInquiriesController, PublicContactInquiriesController],
  providers: [ContactInquiriesService],
})
export class ContactInquiriesModule {}
