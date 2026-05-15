import { Injectable } from '@nestjs/common';
import { NotImplementedException } from '../../../common/exceptions';
import type { IngestionOptions, IngestionResult } from '../types';
import { CsvLoaderService } from './csv-loader.service';
import { ChunkerService } from './chunker.service';
import { EmbedderService } from './embedder.service';

@Injectable()
export class IngestionPipelineService {
  constructor(
    private readonly csvLoader: CsvLoaderService,
    private readonly chunker: ChunkerService,
    private readonly embedder: EmbedderService,
  ) {}

  run(_options: IngestionOptions): Promise<IngestionResult> {
    void this.csvLoader;
    void this.chunker;
    void this.embedder;
    return Promise.reject(
      new NotImplementedException(
        'IngestionPipelineService.run (Phase 1.2 scaffold; arrives in 1.3)',
      ),
    );
  }
}
