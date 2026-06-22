import { zodToJsonSchema } from 'zod-to-json-schema';
import { buildQueryMetadataTool, buildRoutingTools, buildSearchContentTool } from './tool-factory';
import { searchContentBindingSchema } from './search-content.binding-schema';
import { queryMetadataBindingSchema } from './query-metadata.binding-schema';
import { searchContentInputSchema } from './search-content.schema';
import { queryMetadataInputSchema } from './query-metadata.schema';
import {
  QUERY_METADATA_DESCRIPTION,
  QUERY_METADATA_TOOL_NAME,
  SEARCH_CONTENT_DESCRIPTION,
  SEARCH_CONTENT_TOOL_NAME,
} from './tools.constants';
import { MetadataAggregation } from '../metadata/metadata.types';
import type { SearchContentToolService } from './search-content.tool';
import type { QueryMetadataToolService } from './query-metadata.tool';

describe('tool-factory (Phase 5.3.1)', () => {
  // --------------------------------------------------------------------------
  // buildSearchContentTool
  // --------------------------------------------------------------------------
  describe('buildSearchContentTool', () => {
    it('uses the locked name + description + binding-safe schema', () => {
      const service = { execute: jest.fn() } as unknown as SearchContentToolService;
      const tool = buildSearchContentTool(service);

      expect(tool.name).toBe(SEARCH_CONTENT_TOOL_NAME);
      expect(tool.description).toBe(SEARCH_CONTENT_DESCRIPTION);
      expect(tool.schema).toBe(searchContentBindingSchema);
    });

    it('func delegates to service.execute and returns the context string', async () => {
      const execute = jest
        .fn()
        .mockResolvedValue({ passages: [{ text: 't' }], context: 'CTX-STRING' });
      const service = { execute } as unknown as SearchContentToolService;
      const tool = buildSearchContentTool(service);

      const out = (await tool.invoke({ query: 'consciousness', top_k: 3 })) as string;

      expect(execute).toHaveBeenCalledWith({ query: 'consciousness', top_k: 3 });
      expect(out).toBe('CTX-STRING');
    });
  });

  // --------------------------------------------------------------------------
  // buildQueryMetadataTool
  // --------------------------------------------------------------------------
  describe('buildQueryMetadataTool', () => {
    it('uses the locked name + description + binding-safe schema', () => {
      const service = { execute: jest.fn() } as unknown as QueryMetadataToolService;
      const tool = buildQueryMetadataTool(service);

      expect(tool.name).toBe(QUERY_METADATA_TOOL_NAME);
      expect(tool.description).toBe(QUERY_METADATA_DESCRIPTION);
      expect(tool.schema).toBe(queryMetadataBindingSchema);
    });

    it('func delegates to service.execute and returns the summary string', async () => {
      const execute = jest
        .fn()
        .mockResolvedValue({ result: { type: 'count', value: 319 }, summary: 'SUMMARY-STRING' });
      const service = { execute } as unknown as QueryMetadataToolService;
      const tool = buildQueryMetadataTool(service);

      const out = (await tool.invoke({ type: MetadataAggregation.COUNT })) as string;

      expect(execute).toHaveBeenCalledWith({ type: MetadataAggregation.COUNT });
      expect(out).toBe('SUMMARY-STRING');
    });
  });

  // --------------------------------------------------------------------------
  // buildRoutingTools
  // --------------------------------------------------------------------------
  describe('buildRoutingTools', () => {
    it('returns [search_content, query_metadata] in bindTools order', () => {
      const tools = buildRoutingTools(
        { execute: jest.fn() } as unknown as SearchContentToolService,
        { execute: jest.fn() } as unknown as QueryMetadataToolService,
      );
      expect(tools.map((t) => t.name)).toEqual([
        SEARCH_CONTENT_TOOL_NAME,
        QUERY_METADATA_TOOL_NAME,
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // Bug-guard — binding schemas must NOT emit `exclusiveMinimum` (the Gemini 400)
  // --------------------------------------------------------------------------
  describe('binding-safe schema (regression guard for the Gemini exclusiveMinimum 400)', () => {
    // `unknown` param + a single cast avoids the zod-version type friction
    // between the project's zod and the one zod-to-json-schema's types reference.
    const json = (schema: unknown): string =>
      JSON.stringify(zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0]));

    it('search_content binding schema emits NO exclusiveMinimum', () => {
      expect(json(searchContentBindingSchema)).not.toContain('exclusiveMinimum');
    });

    it('query_metadata binding schema emits NO exclusiveMinimum', () => {
      expect(json(queryMetadataBindingSchema)).not.toContain('exclusiveMinimum');
    });

    it('the STRICT schemas DO emit exclusiveMinimum (proves the guard is meaningful)', () => {
      // .int().positive() on top_k / limit is what Gemini rejects — kept strict for
      // runtime validation, isolated from the bound schemas above.
      expect(json(searchContentInputSchema)).toContain('exclusiveMinimum');
      expect(json(queryMetadataInputSchema)).toContain('exclusiveMinimum');
    });
  });
});
