import { Injectable, Logger } from '@nestjs/common';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import type { ChunkMetadata, PodcastMetadata } from '../types';

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

@Injectable()
export class ChunkerService {
  private readonly logger = new Logger(ChunkerService.name);
  private readonly splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  async split(documents: Document<PodcastMetadata>[]): Promise<Document<ChunkMetadata>[]> {
    const allChunks: Document<ChunkMetadata>[] = [];
    let maxChunksPerDoc = 0;

    for (const doc of documents) {
      const splitChunks = await this.splitter.splitDocuments([doc]);
      const totalChunks = splitChunks.length;
      if (totalChunks > maxChunksPerDoc) {
        maxChunksPerDoc = totalChunks;
      }

      splitChunks.forEach((chunk, index) => {
        const sourceMetadata = chunk.metadata as PodcastMetadata;
        const chunkMetadata: ChunkMetadata = {
          ...sourceMetadata,
          chunk_id: `${sourceMetadata.episode_id}_chunk_${index}`,
          chunk_index: index,
          total_chunks: totalChunks,
        };
        allChunks.push(
          new Document<ChunkMetadata>({
            pageContent: chunk.pageContent,
            metadata: chunkMetadata,
          }),
        );
      });
    }

    const avg = documents.length > 0 ? allChunks.length / documents.length : 0;
    this.logger.log(
      `Chunked ${documents.length} document(s) into ${allChunks.length} chunks ` +
        `(avg ${avg.toFixed(1)}/doc, max ${maxChunksPerDoc}/doc, ` +
        `size=${CHUNK_SIZE}, overlap=${CHUNK_OVERLAP})`,
    );

    return allChunks;
  }
}
