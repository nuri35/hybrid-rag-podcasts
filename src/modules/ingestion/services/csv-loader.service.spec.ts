import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CsvLoadFailedException } from '../../../common/exceptions';
import { CsvLoaderService } from './csv-loader.service';

describe('CsvLoaderService', () => {
  let service: CsvLoaderService;
  let workDir: string;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'csv-loader-test-'));
    const moduleRef = await Test.createTestingModule({
      providers: [CsvLoaderService],
    }).compile();
    service = moduleRef.get(CsvLoaderService);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('loads valid sample-podcasts.csv with correct metadata structure', async () => {
    const samplePath = join(process.cwd(), 'data', 'sample-podcasts.csv');
    const documents = await service.load(samplePath);

    expect(documents.length).toBeGreaterThan(0);
    const stats = service.getLastStats();
    expect(stats).not.toBeNull();
    expect(stats?.validRows).toBe(documents.length);
    expect(stats?.skipped).toBe(0);

    const first = documents[0];
    expect(typeof first.pageContent).toBe('string');
    expect(first.pageContent.length).toBeGreaterThan(50);
    expect(first.metadata).toEqual(
      expect.objectContaining({
        episode_id: expect.any(String),
        title: expect.any(String),
        date: expect.any(String),
        guest_name: expect.any(String),
        guest_affiliation: expect.any(String),
        guest_role: expect.any(String),
      }),
    );
    expect(
      typeof first.metadata.duration_min === 'number' || first.metadata.duration_min === null,
    ).toBe(true);
  });

  it('skips rows with empty transcript_text and counts them', async () => {
    const filePath = join(workDir, 'mixed.csv');
    const longText = 'word '.repeat(40); // ~200 chars to satisfy min(100)
    const csv = [
      'episode_id,title,date,duration_min,guest_name,guest_affiliation,guest_role,transcript_text',
      `ep_valid_1,Valid Episode,2024-01-01,60,Alice,Acme,Engineer,"${longText}"`,
      'ep_empty,Empty Transcript,2024-01-02,55,Bob,Acme,Engineer,',
      `ep_valid_2,Another Valid,2024-01-03,75,Carol,Acme,Engineer,"${longText}"`,
      'ep_short,Too Short,2024-01-04,30,Dan,Acme,Engineer,"only forty chars not nearly enough text"',
    ].join('\n');
    await writeFile(filePath, csv, 'utf8');

    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const documents = await service.load(filePath);

    expect(documents.map((d) => d.metadata.episode_id)).toEqual(['ep_valid_1', 'ep_valid_2']);
    const stats = service.getLastStats();
    expect(stats).toEqual({ totalRows: 4, validRows: 2, skipped: 2 });
    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it('throws CsvLoadFailedException when the CSV path does not exist', async () => {
    const missing = join(workDir, 'does-not-exist.csv');
    await expect(service.load(missing)).rejects.toBeInstanceOf(CsvLoadFailedException);
  });

  it('trims leading/trailing whitespace from string fields', async () => {
    const filePath = join(workDir, 'padded.csv');
    const longText = 'word '.repeat(40);
    const csv = [
      'episode_id,title,date,duration_min,guest_name,guest_affiliation,guest_role,transcript_text',
      `  ep_pad_1  ,  Padded Title  ,  2024-05-01  ,  90  ,  Eve  ,  Acme  ,  CTO  ,"${longText}"`,
    ].join('\n');
    await writeFile(filePath, csv, 'utf8');

    const documents = await service.load(filePath);
    expect(documents).toHaveLength(1);
    expect(documents[0].metadata).toEqual(
      expect.objectContaining({
        episode_id: 'ep_pad_1',
        title: 'Padded Title',
        date: '2024-05-01',
        duration_min: 90,
        guest_name: 'Eve',
        guest_affiliation: 'Acme',
        guest_role: 'CTO',
      }),
    );
  });
});
