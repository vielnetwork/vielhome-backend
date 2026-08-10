import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AssignComplianceCaseDto } from './assign-compliance-case.dto';

describe('AssignComplianceCaseDto', () => {
  it('trims and accepts a non-empty canonical Person id', async () => {
    const dto = plainToInstance(AssignComplianceCaseDto, { assignedToId: '  person-1  ' });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.assignedToId).toBe('person-1');
  });

  it.each([{ assignedToId: '' }, { assignedToId: '   ' }, { assignedToId: 1 }, {}])(
    'rejects malformed assignment input %#',
    async (body) => {
      await expect(
        validate(plainToInstance(AssignComplianceCaseDto, body)),
      ).resolves.not.toHaveLength(0);
    },
  );
});
