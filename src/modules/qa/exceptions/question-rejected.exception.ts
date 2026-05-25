import { BadRequestException } from '@nestjs/common';

/**
 * Thrown by `PromptSanitizationService.inspect` callers when the input
 * matches a hard-reject pattern or exceeds the length cap.
 *
 * The public message is GENERIC by design — telling the attacker which
 * pattern matched would help them iterate. The specific reason +
 * pattern IDs live in the WARN log line under the correlation ID.
 */
export class QuestionRejectedException extends BadRequestException {
  constructor() {
    super({
      statusCode: 400,
      message: 'Your question cannot be processed. Please rephrase and try again.',
      error: 'Bad Request',
    });
    this.name = 'QuestionRejectedException';
  }
}
