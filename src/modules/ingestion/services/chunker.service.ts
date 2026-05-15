import { Injectable } from '@nestjs/common';
import type { Document } from '@langchain/core/documents';
import { NotImplementedException } from '../../../common/exceptions';
import type { PodcastMetadata } from '../types';

@Injectable()
export class ChunkerService {
  split(_documents: Document<PodcastMetadata>[]): Document<PodcastMetadata>[] {
    throw new NotImplementedException('ChunkerService.split (Phase 1.2 scaffold; arrives in 1.3)');
  }
}
