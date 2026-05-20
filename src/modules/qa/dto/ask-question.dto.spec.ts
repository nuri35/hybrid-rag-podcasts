import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AskQuestionDto } from './ask-question.dto';

/**
 * Mirrors the global `ValidationPipe` config in `main.ts`:
 *   - whitelist: true
 *   - forbidNonWhitelisted: true
 *   - transform: true (with enableImplicitConversion)
 *
 * `plainToInstance` materialises the DTO the way `ValidationPipe` does
 * before delegating to `validate()`. Tests assert on the resulting
 * `ValidationError[]` constraint keys so a class-validator decorator
 * removal would surface as a failing test.
 */
async function validateDto(plain: object): Promise<{ errors: string[] }> {
  const dto = plainToInstance(AskQuestionDto, plain, {
    enableImplicitConversion: true,
  });
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  const constraintKeys: string[] = [];
  for (const err of errors) {
    if (err.constraints) {
      constraintKeys.push(...Object.keys(err.constraints));
    }
  }
  return { errors: constraintKeys };
}

describe('AskQuestionDto', () => {
  describe('valid input', () => {
    it('accepts a question alone (topK omitted)', async () => {
      const { errors } = await validateDto({ question: 'What is consciousness?' });
      expect(errors).toEqual([]);
    });

    it('accepts question + topK in range', async () => {
      const { errors } = await validateDto({ question: 'a valid question', topK: 5 });
      expect(errors).toEqual([]);
    });

    it('accepts boundary topK values (1 and 50)', async () => {
      const lower = await validateDto({ question: 'a valid question', topK: 1 });
      const upper = await validateDto({ question: 'a valid question', topK: 50 });
      expect(lower.errors).toEqual([]);
      expect(upper.errors).toEqual([]);
    });
  });

  describe('invalid question', () => {
    it('rejects missing question (isString triggers)', async () => {
      const { errors } = await validateDto({});
      expect(errors).toContain('isString');
    });

    it('rejects question shorter than 3 chars', async () => {
      const { errors } = await validateDto({ question: 'hi' });
      expect(errors).toContain('minLength');
    });

    it('rejects question longer than 1000 chars', async () => {
      const { errors } = await validateDto({ question: 'x'.repeat(1001) });
      expect(errors).toContain('maxLength');
    });
  });

  describe('invalid topK', () => {
    it('rejects topK below 1', async () => {
      const { errors } = await validateDto({ question: 'a valid question', topK: 0 });
      expect(errors).toContain('min');
    });

    it('rejects topK above 50', async () => {
      const { errors } = await validateDto({ question: 'a valid question', topK: 51 });
      expect(errors).toContain('max');
    });

    it('rejects non-integer topK', async () => {
      const { errors } = await validateDto({ question: 'a valid question', topK: 3.5 });
      expect(errors).toContain('isInt');
    });
  });

  describe('forbidNonWhitelisted', () => {
    it('rejects unknown properties (forbidNonWhitelisted: true)', async () => {
      const { errors } = await validateDto({
        question: 'a valid question',
        hackerField: 'x',
      });
      expect(errors).toContain('whitelistValidation');
    });
  });
});
