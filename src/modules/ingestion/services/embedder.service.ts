import { Injectable } from '@nestjs/common';
import type { Document } from '@langchain/core/documents';
import { NotImplementedException } from '../../../common/exceptions';
import type { PodcastMetadata } from '../types';

@Injectable()
export class EmbedderService {
  embedBatch(_documents: Document<PodcastMetadata>[]): Promise<number[][]> {
    return Promise.reject(
      new NotImplementedException(
        'EmbedderService.embedBatch (Phase 1.2 scaffold; arrives in 1.3)',
      ),
    );
  }
}
