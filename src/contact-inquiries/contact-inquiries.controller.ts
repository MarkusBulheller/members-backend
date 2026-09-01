import { Body, Controller, Delete, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator.js';
import { Role } from '../common/enums/role.enum.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { ContactInquiriesService } from './contact-inquiries.service.js';
import { UpdateContactInquiryDto } from './dto/update-contact-inquiry.dto.js';

/** Admin-only review of "Join the Grid" submissions from the public marketing site — see
 * PublicContactInquiriesController for the actual (unguarded) submit endpoint. */
@Controller('contact-inquiries')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class ContactInquiriesController {
  constructor(private readonly contactInquiriesService: ContactInquiriesService) {}

  @Get()
  list() {
    return this.contactInquiriesService.list();
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateContactInquiryDto) {
    return this.contactInquiriesService.setReviewed(id, dto.reviewed);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.contactInquiriesService.remove(id);
  }
}
