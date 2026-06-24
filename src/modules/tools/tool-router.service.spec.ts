import { Logger } from '@nestjs/common';
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { ToolRouterService } from './tool-router.service';
import {
  ROUTER_SYSTEM_PROMPT,
  SEARCH_CONTENT_TOOL_NAME,
  QUERY_METADATA_TOOL_NAME,
  TOOL_INVALID_INPUT_MESSAGE,
} from './tools.constants';
import { InvalidToolInputException } from './exceptions/invalid-tool-input.exception';
import { MetadataQueryFailedException } from '../metadata/exceptions';
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
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
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

    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    service = new ToolRouterService(llm, search, metadata);
  });

  afterEach(() => jest.restoreAllMocks());

  /** Messages array passed to the (single) final UNBOUND invoke. */
  const finalMessagesOf = (invoke: jest.Mock): BaseMessage[] => {
    const calls = invoke.mock.calls as unknown as BaseMessage[][][];
    return calls[0][0];
  };

  /** The per-tool `tool_dispatch …` log lines emitted this run (log + warn). */
  const dispatchLines = (): string[] => {
    const calls = [
      ...(logSpy.mock.calls as unknown as string[][]),
      ...(warnSpy.mock.calls as unknown as string[][]),
    ];
    return calls.map((c) => c[0]).filter((line) => line.startsWith('tool_dispatch'));
  };

  it('binds tools exactly once at construction (the only bindTools call)', () => {
    expect(bindTools).toHaveBeenCalledTimes(1);
    expect(createChatModel).toHaveBeenCalledTimes(1);
  });

  it('injects ROUTER_SYSTEM_PROMPT as the leading SystemMessage, then the question', async () => {
    boundInvoke.mockResolvedValue({ content: 'hi', tool_calls: [] });

    await service.route('hello there');

    const messages = (boundInvoke.mock.calls as unknown as BaseMessage[][][])[0][0];
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[0].content).toBe(ROUTER_SYSTEM_PROMPT);
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(messages[1].content).toBe('hello there');
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
  // Parallel path — multiple tool_calls in one round (single-shot ≠ single-tool)
  // --------------------------------------------------------------------------
  describe('parallel path', () => {
    it('executes ALL tool_calls, feeds one ToolMessage per call back, single UNBOUND final', async () => {
      boundInvoke.mockResolvedValue({
        content: '',
        tool_calls: [
          { name: SEARCH_CONTENT_TOOL_NAME, args: { query: 'consciousness' }, id: 'a' },
          { name: QUERY_METADATA_TOOL_NAME, args: { type: 'count' }, id: 'b' },
        ],
      });
      searchExecute.mockResolvedValue({ passages: [], context: 'CTX' });
      metadataExecute.mockResolvedValue({ result: { type: 'count', value: 319 }, summary: 'SUM' });
      unboundInvoke.mockResolvedValue({ content: 'COMBINED ANSWER' });

      const result = await service.route('What is consciousness and how many episodes are there?');

      // both tools dispatched (parallel)
      expect(searchExecute).toHaveBeenCalledWith({ query: 'consciousness' });
      expect(metadataExecute).toHaveBeenCalledWith({ type: 'count' });

      // single-shot: still exactly one bound call (round 1) and one UNBOUND final
      expect(boundInvoke).toHaveBeenCalledTimes(1);
      expect(unboundInvoke).toHaveBeenCalledTimes(1);
      expect(bindTools).toHaveBeenCalledTimes(1);

      // exactly one ToolMessage per tool_call, each with its own tool_call_id
      const toolMessages = finalMessagesOf(unboundInvoke).filter((m) => m instanceof ToolMessage);
      expect(toolMessages).toHaveLength(2);
      expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['a', 'b']);
      expect(toolMessages.map((m) => m.content)).toEqual(['CTX', 'SUM']);

      expect(result.answer).toBe('COMBINED ANSWER');
      expect(result.toolUsed).toEqual([SEARCH_CONTENT_TOOL_NAME, QUERY_METADATA_TOOL_NAME]);
    });

    it('mixed: one tool succeeds + one throws InvalidToolInputException → success kept, failed → controlled-error', async () => {
      boundInvoke.mockResolvedValue({
        content: '',
        tool_calls: [
          { name: SEARCH_CONTENT_TOOL_NAME, args: { query: 'x' }, id: 'a' },
          { name: QUERY_METADATA_TOOL_NAME, args: { type: 'count' }, id: 'b' },
        ],
      });
      searchExecute.mockResolvedValue({ passages: [], context: 'CTX' });
      metadataExecute.mockRejectedValue(new InvalidToolInputException('bad args'));
      unboundInvoke.mockResolvedValue({ content: 'ANSWER' });

      const result = await service.route('q');

      // allSettled: the successful result is preserved, the failed one becomes a
      // controlled-error ToolMessage — one ToolMessage per call, both fed forward.
      const toolMessages = finalMessagesOf(unboundInvoke).filter((m) => m instanceof ToolMessage);
      expect(toolMessages).toHaveLength(2);
      expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['a', 'b']);
      expect(toolMessages[0].content).toBe('CTX');
      expect(toolMessages[1].content).toBe(TOOL_INVALID_INPUT_MESSAGE);
      expect(result.toolUsed).toEqual([SEARCH_CONTENT_TOOL_NAME, QUERY_METADATA_TOOL_NAME]);
    });

    it('parallel with a MetadataQueryFailedException in one branch → route propagates (fail-loud wins)', async () => {
      boundInvoke.mockResolvedValue({
        content: '',
        tool_calls: [
          { name: SEARCH_CONTENT_TOOL_NAME, args: { query: 'x' }, id: 'a' },
          { name: QUERY_METADATA_TOOL_NAME, args: { type: 'count' }, id: 'b' },
        ],
      });
      searchExecute.mockResolvedValue({ passages: [], context: 'CTX' });
      metadataExecute.mockRejectedValue(new MetadataQueryFailedException('cluster down'));

      await expect(service.route('q')).rejects.toBeInstanceOf(MetadataQueryFailedException);
      // fail-loud: the final answer invoke never happens
      expect(unboundInvoke).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Fallback policy (5.3.5) — exception-type routing: graceful vs fail-loud
  // --------------------------------------------------------------------------
  describe('fallback policy', () => {
    it('InvalidToolInputException → controlled-error ToolMessage, final invoke still answers', async () => {
      boundInvoke.mockResolvedValue({
        content: '',
        tool_calls: [{ name: QUERY_METADATA_TOOL_NAME, args: { type: 'count' }, id: 'b' }],
      });
      metadataExecute.mockRejectedValue(new InvalidToolInputException('bad args'));
      unboundInvoke.mockResolvedValue({ content: "I don't have that information." });

      const result = await service.route('q');

      const toolMessage = finalMessagesOf(unboundInvoke).find((m) => m instanceof ToolMessage);
      expect(toolMessage?.content).toBe(TOOL_INVALID_INPUT_MESSAGE);
      expect(toolMessage?.tool_call_id).toBe('b');
      expect(unboundInvoke).toHaveBeenCalledTimes(1);
      expect(result.answer).toBe("I don't have that information.");
    });

    it('MetadataQueryFailedException → propagates out of route(), no final invoke (fail-loud)', async () => {
      boundInvoke.mockResolvedValue({
        content: '',
        tool_calls: [{ name: QUERY_METADATA_TOOL_NAME, args: { type: 'count' }, id: 'b' }],
      });
      metadataExecute.mockRejectedValue(new MetadataQueryFailedException('cluster down'));

      await expect(service.route('q')).rejects.toBeInstanceOf(MetadataQueryFailedException);
      expect(unboundInvoke).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Per-tool logging — name + latency + status
  // --------------------------------------------------------------------------
  describe('per-tool logging', () => {
    it('logs name + latency + status=success on a fulfilled call', async () => {
      boundInvoke.mockResolvedValue({
        content: '',
        tool_calls: [{ name: SEARCH_CONTENT_TOOL_NAME, args: { query: 'x' }, id: 'a' }],
      });
      searchExecute.mockResolvedValue({ passages: [], context: 'CTX' });
      unboundInvoke.mockResolvedValue({ content: 'A' });

      await service.route('q');

      const line = dispatchLines().find((l) => l.includes(`name=${SEARCH_CONTENT_TOOL_NAME}`));
      expect(line).toMatch(/status=success/);
      expect(line).toMatch(/latency_ms=\d+/);
    });

    it('logs status=invalid_input on bad args and status=failed on a system error', async () => {
      // invalid_input
      boundInvoke.mockResolvedValue({
        content: '',
        tool_calls: [{ name: QUERY_METADATA_TOOL_NAME, args: { type: 'count' }, id: 'b' }],
      });
      metadataExecute.mockRejectedValueOnce(new InvalidToolInputException('bad'));
      unboundInvoke.mockResolvedValue({ content: 'A' });
      await service.route('q');
      expect(dispatchLines().some((l) => /status=invalid_input/.test(l))).toBe(true);

      // failed (system error)
      logSpy.mockClear();
      warnSpy.mockClear();
      metadataExecute.mockRejectedValueOnce(new MetadataQueryFailedException('down'));
      await expect(service.route('q')).rejects.toBeInstanceOf(MetadataQueryFailedException);
      expect(dispatchLines().some((l) => /status=failed/.test(l))).toBe(true);
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

      // per-tool logging: the fourth status (unknown_tool) is emitted too
      const line = dispatchLines().find((l) => l.includes('name=nonexistent_tool'));
      expect(line).toMatch(/status=unknown_tool/);
      expect(line).toMatch(/latency_ms=\d+/);
    });
  });
});
