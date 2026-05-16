import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Document } from '@langchain/core/documents';
import { ChunkerService } from './chunker.service';
import type { PodcastMetadata } from '../types';

function makeDoc(episodeId: string, length: number, overrides: Partial<PodcastMetadata> = {}) {
  const word = 'lorem ipsum dolor sit amet consectetur adipiscing elit ';
  let text = '';
  while (text.length < length) {
    text += word;
  }
  text = text.slice(0, length);

  const metadata: PodcastMetadata = {
    episode_id: episodeId,
    title: `Title for ${episodeId}`,
    date: '2024-01-01',
    duration_min: 60,
    guest_name: 'Test Guest',
    guest_affiliation: 'Test Org',
    guest_role: 'Test Role',
    ...overrides,
  };
  return new Document<PodcastMetadata>({ pageContent: text, metadata });
}

describe('ChunkerService', () => {
  let service: ChunkerService;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ChunkerService],
    }).compile();
    service = moduleRef.get(ChunkerService);
  });

  it('produces exactly one chunk with index 0 for a short (300-char) document', async () => {
    const doc = makeDoc('ep_short', 300);
    const chunks = await service.split([doc]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.chunk_id).toBe('ep_short_chunk_0');
    expect(chunks[0].metadata.chunk_index).toBe(0);
    expect(chunks[0].metadata.total_chunks).toBe(1);
  });

  it('produces multiple chunks with sequential ids for a long (3000-char) document', async () => {
    const doc = makeDoc('ep_long', 3000);
    const chunks = await service.split([doc]);

    expect(chunks.length).toBeGreaterThan(1);
    const total = chunks.length;
    chunks.forEach((chunk, idx) => {
      expect(chunk.metadata.chunk_id).toBe(`ep_long_chunk_${idx}`);
      expect(chunk.metadata.chunk_index).toBe(idx);
      expect(chunk.metadata.total_chunks).toBe(total);
    });
  });

  it('preserves every original PodcastMetadata field on every chunk', async () => {
    const doc = makeDoc('ep_meta', 1800, {
      title: 'The Meta Test',
      date: '2025-07-04',
      duration_min: 123,
      guest_name: 'Ada Lovelace',
      guest_affiliation: 'Analytical Engine Co',
      guest_role: 'Mathematician',
    });
    const chunks = await service.split([doc]);
    expect(chunks.length).toBeGreaterThan(0);

    for (const chunk of chunks) {
      expect(chunk.metadata.episode_id).toBe('ep_meta');
      expect(chunk.metadata.title).toBe('The Meta Test');
      expect(chunk.metadata.date).toBe('2025-07-04');
      expect(chunk.metadata.duration_min).toBe(123);
      expect(chunk.metadata.guest_name).toBe('Ada Lovelace');
      expect(chunk.metadata.guest_affiliation).toBe('Analytical Engine Co');
      expect(chunk.metadata.guest_role).toBe('Mathematician');
    }
  });

  it('processes multiple documents independently without chunk_id collisions', async () => {
    const docA = makeDoc('ep_a', 2400);
    const docB = makeDoc('ep_b', 1600);
    const docC = makeDoc('ep_c', 300);

    const chunks = await service.split([docA, docB, docC]);

    const groupedByEpisode = new Map<string, number[]>();
    const allIds = new Set<string>();
    for (const chunk of chunks) {
      const episodeId = chunk.metadata.episode_id;
      allIds.add(chunk.metadata.chunk_id);
      const existing = groupedByEpisode.get(episodeId) ?? [];
      existing.push(chunk.metadata.chunk_index);
      groupedByEpisode.set(episodeId, existing);
    }

    expect(allIds.size).toBe(chunks.length);

    for (const [episodeId, indices] of groupedByEpisode.entries()) {
      const sorted = [...indices].sort((a, b) => a - b);
      expect(sorted[0]).toBe(0);
      expect(sorted[sorted.length - 1]).toBe(sorted.length - 1);
      const totalForEpisode = sorted.length;
      const totalsForEpisode = chunks
        .filter((c) => c.metadata.episode_id === episodeId)
        .map((c) => c.metadata.total_chunks);
      expect(totalsForEpisode.every((t) => t === totalForEpisode)).toBe(true);
    }
  });
});
