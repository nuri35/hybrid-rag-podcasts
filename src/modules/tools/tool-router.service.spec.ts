import { Logger } from '@nestjs/common';
import { ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ToolRouterService } from './tool-router.service';
import { SEARCH_CONTENT_TOOL_NAME, QUERY_METADATA_TOOL_NAME } from './tools.constants';
import type { LlmService } from '../llm/llm.service';
import type { SearchContentToolService } from './search-content.tool';
import type { QueryMetadataToolService } from './query-metadata.tool';

/**
 * Unit tests — Phase 5.3.2. The LLM is fully mocked (no real Gemini): a fake
 * tool-calling model whose `bindTools()` returns a stub with a controllable
 * `invoke` (call 1), and a separate unbound model stub (call 2). The single-shot
 * guarantee is asserted structurally — the final invoke goes to the UNBOUND model,
 * and `bindTools` is called exactly once (at construction), never for the final.
 */
describe('ToolRouterService (Phase 5.3.2)', () => {
  let boundInvoke: jest.Mock;
  let unboundInvoke: jest.Mock;
  let bindTools: jest.Mock;
  let searchExecute: jest.Mock;
  let metadataExecute: jest.Mock;
  let createToolCallingModel: jest.Mock;
  let createChatModel: jest.Mock;
  let service: ToolRouterService;

  beforeEach(() => {
    boundInvoke = jest.fn();
    unboundInvoke = jest.fn();
    bindTools = jest.fn().mockReturnValue({ invoke: boundInvoke });
    createToolCallingModel = jest.fn().mockReturnValue({ bindTools });
    createChatModel = jest.fn().mockReturnValue({ invoke: unboundInvoke });
    searchExecute = jest.fn();
    metadataExecute = jest.fn();

    const llm = { createToolCallingModel, createChatModel } as unknown as LlmService;
    const search = { execute: searchExecute } as unknown as SearchContentToolService;
    const metadata = { execute: metadataExecute } as unknown as QueryMetadataToolService;

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    service = new ToolRouterService(llm, search, metadata);
  });

  afterEach(() => jest.restoreAllMocks());

  /** Messages array passed to the (single) final UNBOUND invoke. */
  const finalMessagesOf = (invoke: jest.Mock): BaseMessage[] => {
    const calls = invoke.mock.calls as unknown as BaseMessage[][][];
    return calls[0][0];
  };

  it('binds tools exactly once at construction (the only bindTools call)', () => {
    expect(bindTools).toHaveBeenCalledTimes(1);
    expect(createChatModel).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // Tool path — dispatch, feed back, UNBOUND final invoke
  // --------------------------------------------------------------------------
  describe('tool path', () => {
    it('dispatches the chosen tool, feeds a ToolMessage back, and answers via the UNBOUND model', async () => {
      boundInvoke.mockResolvedValue({
        content: '',
        tool_calls: [
          { name: SEARCH_CONTENT_TOOL_NAME, args: { query: 'constructors' }, id: 'call_1' },
        ],
      });
      searchExecute.mockResolvedValue({ passages: [], context: 'CTX-PASSAGES' });
      unboundInvoke.mockResolvedValue({ content: 'FINAL ANSWER [Source 1]' });

      const result = await service.route('What did Cronin say about constructors?');

      // correct service dispatched with the model's args
      expect(searchExecute).toHaveBeenCalledWith({ query: 'constructors' });
      expect(metadataExecute).not.toHaveBeenCalled();

      // single-shot guard: bound model called once (call 1), unbound once (call 2),
      // and bindTools was NOT called again for the final invoke.
      expect(boundInvoke).toHaveBeenCalledTimes(1);
      expect(unboundInvoke).toHaveBeenCalledTimes(1);
      expect(bindTools).toHaveBeenCalledTimes(1);

      // the ToolMessage (content from the tool, carrying the tool_call_id) was fed back
      const toolMessage = finalMessagesOf(unboundInvoke).find(
        (m) => m instanceof ToolMessage,
      ) as ToolMessage;
      expect(toolMessage).toBeDefined();
      expect(toolMessage.content).toBe('CTX-PASSAGES');
      expect(toolMessage.tool_call_id).toBe('call_1');

      expect(result.answer).toBe('FINAL ANSWER [Source 1]');
      expect(result.toolUsed).toEqual([SEARCH_CONTENT_TOOL_NAME]);
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('routes a query_metadata tool_call to the metadata service', async () => {
      boundInvoke.mockResolvedValue({
        content: '',
        tool_calls: [{ name: QUERY_METADATA_TOOL_NAME, args: { type: 'count' }, id: 'c2' }],
      });
      metadataExecute.mockResolvedValue({
        result: { type: 'count', value: 319 },
        summary: '319 episodes.',
      });
      unboundInvoke.mockResolvedValue({ content: 'There are 319 episodes.' });

      const result = await service.route('How many episodes are there?');

      expect(metadataExecute).toHaveBeenCalledWith({ type: 'count' });
      expect(searchExecute).not.toHaveBeenCalled();
      expect(result.toolUsed).toEqual([QUERY_METADATA_TOOL_NAME]);
      expect(result.answer).toBe('There are 319 episodes.');
    });
  });

  // --------------------------------------------------------------------------
  // No-tool path — direct answer, NO second call
  // --------------------------------------------------------------------------
  describe('no-tool path', () => {
    it('returns the model content directly with NO second invoke', async () => {
      boundInvoke.mockResolvedValue({ content: 'Hello! How can I help?', tool_calls: [] });

      const result = await service.route('Hi there');

      expect(unboundInvoke).not.toHaveBeenCalled();
      expect(searchExecute).not.toHaveBeenCalled();
      expect(metadataExecute).not.toHaveBeenCalled();
      expect(result.answer).toBe('Hello! How can I help?');
      expect(result.toolUsed).toEqual([]);
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('treats a missing tool_calls field as the no-tool path', async () => {
      boundInvoke.mockResolvedValue({ content: 'Direct answer' });

      const result = await service.route('anything');

      expect(unboundInvoke).not.toHaveBeenCalled();
      expect(result.toolUsed).toEqual([]);
      expect(result.answer).toBe('Direct answer');
    });

    it('flattens array (content-part) message content to text', async () => {
      boundInvoke.mockResolvedValue({
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
        tool_calls: [],
      });

      const result = await service.route('q');

      expect(result.answer).toBe('part one part two');
    });
  });

  // --------------------------------------------------------------------------
  // Dispatch map — unknown tool name handled safely (no throw)
  // --------------------------------------------------------------------------
  describe('dispatch map', () => {
    it('handles an unknown tool name safely (controlled ToolMessage, still answers)', async () => {
      boundInvoke.mockResolvedValue({
        content: '',
        tool_calls: [{ name: 'nonexistent_tool', args: {}, id: 'cx' }],
      });
      unboundInvoke.mockResolvedValue({ content: 'I could not run that.' });

      const result = await service.route('weird');

      // neither real tool ran; the flow did not throw; the unbound final still answered
      expect(searchExecute).not.toHaveBeenCalled();
      expect(metadataExecute).not.toHaveBeenCalled();
      expect(unboundInvoke).toHaveBeenCalledTimes(1);

      const toolMessage = finalMessagesOf(unboundInvoke).find(
        (m) => m instanceof ToolMessage,
      ) as ToolMessage;
      expect(toolMessage.content).toContain('Unknown tool');
      expect(result.answer).toBe('I could not run that.');
    });
  });
});
