import { Injectable, Logger } from '@nestjs/common';
import { Document } from '@langchain/core/documents';
import { parse } from 'csv-parse';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { CsvLoadFailedException } from '../../../common/exceptions';
import { CsvRowSchema, type PodcastMetadata } from '../types';

export interface CsvLoaderStats {
  totalRows: number;
  validRows: number;
  skipped: number;
}

@Injectable()
export class CsvLoaderService {
  private readonly logger = new Logger(CsvLoaderService.name);
  private lastStats: CsvLoaderStats | null = null;

  getLastStats(): CsvLoaderStats | null {
    return this.lastStats;
  }

  async load(filePath: string): Promise<Document<PodcastMetadata>[]> {
    await this.ensureReadable(filePath);

    const parser = createReadStream(filePath).pipe(
      parse({ columns: true, skip_empty_lines: true, trim: true }),
    );

    const documents: Document<PodcastMetadata>[] = [];
    const stats: CsvLoaderStats = { totalRows: 0, validRows: 0, skipped: 0 };

    try {
      for await (const rawRow of parser) {
        stats.totalRows += 1;
        const parsed = CsvRowSchema.safeParse(rawRow);
        if (!parsed.success) {
          stats.skipped += 1;
          const reason = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
          this.logger.warn(`Skipping row ${stats.totalRows} in ${filePath} — ${reason}`);
          continue;
        }

        const row = parsed.data;
        const metadata: PodcastMetadata = {
          episode_id: row.episode_id,
          title: row.title,
          date: row.date,
          duration_min: row.duration_min,
          guest_name: row.guest_name,
          guest_affiliation: row.guest_affiliation,
          guest_role: row.guest_role,
        };
        documents.push(
          new Document<PodcastMetadata>({
            pageContent: row.transcript_text,
            metadata,
          }),
        );
        stats.validRows += 1;
      }
    } catch (error) {
      throw new CsvLoadFailedException(
        filePath,
        error instanceof Error ? error.message : String(error),
      );
    }

    this.lastStats = stats;
    this.logger.log(
      `Loaded ${stats.validRows}/${stats.totalRows} rows from ${filePath} (skipped ${stats.skipped})`,
    );

    return documents;
  }

  private async ensureReadable(filePath: string): Promise<void> {
    try {
      await access(filePath, constants.R_OK);
    } catch (error) {
      throw new CsvLoadFailedException(
        filePath,
        error instanceof Error ? error.message : 'file not found or unreadable',
      );
    }
  }
}
