import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { LookupRaceResultDto } from './lookup-race-result.dto.js';

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const run = (body: unknown) => pipe.transform(body, { type: 'body', metatype: LookupRaceResultDto });

describe('LookupRaceResultDto', () => {
  it('accepts a positive team id as is', async () => {
    const dto = (await run({ subsessionId: 81234567, teamId: 287336 })) as LookupRaceResultDto;
    expect(dto.teamId).toBe(287336);
  });

  it("accepts iRacing's negative team id and normalises it to the positive id", async () => {
    const dto = (await run({ subsessionId: 81234567, teamId: -287336 })) as LookupRaceResultDto;
    expect(dto.teamId).toBe(287336);
  });

  it('accepts string numbers (query/form values) with either sign', async () => {
    const dto = (await run({ subsessionId: '81234567', teamId: '-287336' })) as LookupRaceResultDto;
    expect(dto).toMatchObject({ subsessionId: 81234567, teamId: 287336 });
  });

  it('still rejects zero and non-numeric team ids', async () => {
    await expect(run({ subsessionId: 1, teamId: 0 })).rejects.toBeDefined();
    await expect(run({ subsessionId: 1, teamId: 'abc' })).rejects.toBeDefined();
  });
});
