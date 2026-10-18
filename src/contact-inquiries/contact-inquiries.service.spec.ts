import { describe, expect, it, vi } from 'vitest';
import { ContactInquiriesService } from './contact-inquiries.service.js';

describe('ContactInquiriesService.countUnreviewed', () => {
  it('returns { count } from a COUNT query without loading rows', async () => {
    const repository = { count: vi.fn().mockResolvedValue(4), find: vi.fn() };
    const service = new ContactInquiriesService(repository as never);

    await expect(service.countUnreviewed()).resolves.toEqual({ count: 4 });

    expect(repository.count).toHaveBeenCalledWith({ where: { reviewed: false } });
    expect(repository.find).not.toHaveBeenCalled();
  });
});
