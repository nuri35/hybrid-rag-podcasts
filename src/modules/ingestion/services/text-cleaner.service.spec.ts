import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TextCleanerService } from './text-cleaner.service';

interface CleaningFlagOverrides {
  CLEANING_REMOVE_INTRO?: boolean;
  CLEANING_REMOVE_OUTRO?: boolean;
  CLEANING_REMOVE_SPONSORS?: boolean;
  CLEANING_REMOVE_FILLERS?: boolean;
}

function makeConfig(overrides: CleaningFlagOverrides = {}): ConfigService {
  const values: Record<string, unknown> = {
    CLEANING_REMOVE_INTRO: true,
    CLEANING_REMOVE_OUTRO: true,
    CLEANING_REMOVE_SPONSORS: false,
    CLEANING_REMOVE_FILLERS: false,
    ...overrides,
  };
  return {
    get: (key: string): unknown => values[key],
  } as unknown as ConfigService;
}

async function buildService(overrides: CleaningFlagOverrides = {}): Promise<TextCleanerService> {
  const moduleRef = await Test.createTestingModule({
    providers: [TextCleanerService, { provide: ConfigService, useValue: makeConfig(overrides) }],
  }).compile();
  return moduleRef.get(TextCleanerService);
}

describe('TextCleanerService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('normalizes smart quotes and apostrophes to straight ASCII equivalents', async () => {
    const service = await buildService();
    const input = '“Hello”, he said — it’s a ‘test’.';
    const output = service.clean(input);
    expect(output).not.toMatch(/[“”‘’]/);
    expect(output).toContain('"Hello"');
    expect(output).toContain("it's");
    expect(output).toContain("'test'");
  });

  it('normalizes whitespace: collapses runs of spaces, strips NBSP, collapses 3+ newlines', async () => {
    const service = await buildService();
    const input = 'AI    is smart\n\n\n\nNext block here.';
    const output = service.clean(input);
    expect(output).toContain('AI is smart');
    expect(output).not.toContain('  ');
    expect(output).not.toContain(' ');
    expect(output).not.toMatch(/\n{3,}/);
    expect(output).toContain('\n\n');
  });

  it('collapses repeated punctuation', async () => {
    const service = await buildService();
    const output = service.clean('Wow!!!! Really???? Hmm.... Indeed.');
    expect(output).toContain('Wow!');
    expect(output).toContain('Really?');
    expect(output).toContain('Hmm...');
    expect(output).not.toMatch(/!!/);
    expect(output).not.toMatch(/\?\?/);
    expect(output).not.toMatch(/\.{4,}/);
  });

  it('dedupes 3+ identical consecutive sentences but leaves 2 repetitions untouched', async () => {
    const service = await buildService();
    const triple = service.clean('Hello world. Hello world. Hello world. Different sentence.');
    expect(triple).toBe('Hello world. Different sentence.');

    const double = service.clean('Repeat me. Repeat me. Next thing.');
    expect(double).toBe('Repeat me. Repeat me. Next thing.');
  });

  it('strips Lex intro when the anchor phrase is present', async () => {
    const service = await buildService();
    const input =
      "Some intro context that should be removed. And now, dear friends, here's Max. So Max, tell me about robots.";
    const output = service.clean(input);
    expect(output).toBe('So Max, tell me about robots.');
  });

  it('leaves text unchanged when no Lex intro anchor matches (no false positives)', async () => {
    const service = await buildService();
    const input = 'A standalone sentence with no intro anchor whatsoever.';
    const output = service.clean(input);
    expect(output).toBe(input);
  });

  it('strips Lex outro when the anchor phrase is present', async () => {
    const service = await buildService();
    const input =
      'Real content here. Thank you for listening to this conversation with Max. See you next time.';
    const output = service.clean(input);
    expect(output).toContain('Real content here.');
    expect(output).not.toMatch(/Thank you for listening/i);
    expect(output).not.toContain('See you next time');
  });

  it('is idempotent: clean(clean(x)) === clean(x) across all noise types', async () => {
    const service = await buildService();
    const noisy =
      '“Hi!”    he said  loudly. Hello.... Hello.... Hello.... ' +
      'Then we continued.\n\n\n\nAnother paragraph. ' +
      "And now, dear friends, here's Guest. Real talk begins now. " +
      'Real talk continues. Thank you for listening to this conversation with Guest. Bye.';
    const once = service.clean(noisy);
    const twice = service.clean(once);
    expect(twice).toBe(once);
  });

  it('returns empty string unchanged', async () => {
    const service = await buildService();
    expect(service.clean('')).toBe('');
  });

  it('logs warnings when sponsor/filler flags are on but does not modify text', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = await buildService({
      CLEANING_REMOVE_SPONSORS: true,
      CLEANING_REMOVE_FILLERS: true,
    });

    const input = 'A plain sentence without any noise.';
    const output = service.clean(input);
    expect(output).toBe(input);

    const messages = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(messages.some((m) => m.includes('Sponsor removal not implemented'))).toBe(true);
    expect(messages.some((m) => m.includes('Filler removal not implemented'))).toBe(true);

    warnSpy.mockRestore();
  });
});
