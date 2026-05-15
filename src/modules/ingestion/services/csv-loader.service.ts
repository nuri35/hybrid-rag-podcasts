import { Injectable } from '@nestjs/common';
import type { Document } from '@langchain/core/documents';
import { NotImplementedException } from '../../../common/exceptions';
import type { PodcastMetadata } from '../types';

@Injectable()
export class CsvLoaderService {
  load(_filePath: string): Promise<Document<PodcastMetadata>[]> {
    return Promise.reject(
      new NotImplementedException('CsvLoaderService.load (Phase 1.2 scaffold; arrives in 1.3)'),
    );
  }
}
