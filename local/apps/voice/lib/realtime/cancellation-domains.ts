import type { LocalIdentifier } from '../workflow/identifiers';

export interface SarvamPlaybackController {
  stopPlayback(): Promise<void> | void;
}

export interface RealtimeResponseController {
  cancelResponse(): Promise<boolean>;
}

export interface PhoneTaskCancellationController {
  cancelTask(
    taskId: LocalIdentifier<'task'>,
  ): Promise<unknown> | unknown;
}

export type PushToTalkInterruptionResultV1 = {
  modelResponse: 'cancelled' | 'idle';
  phoneOperation: 'unchanged';
  sarvamPlayback: 'stopped';
  version: 1;
};

type ObsoleteOutputInterruptionResultV1 =
  PushToTalkInterruptionResultV1;

/**
 * Keeps user-visible playback, model generation, and phone mutations in
 * separate cancellation domains.
 *
 * Push-to-talk is deliberately incapable of cancelling a phone operation.
 * Explicit task cancellation is the only method that receives the phone
 * cancellation controller.
 */
export class RealtimeCancellationDomains {
  private readonly playback: SarvamPlaybackController;
  private readonly response: RealtimeResponseController;

  constructor(input: {
    playback: SarvamPlaybackController;
    response: RealtimeResponseController;
  }) {
    this.playback = input.playback;
    this.response = input.response;
  }

  async interruptForPushToTalk(): Promise<PushToTalkInterruptionResultV1> {
    return this.interruptObsoleteOutput();
  }

  /**
   * Stops output superseded by newer authoritative presentation state.
   * The class holds no phone-operation controller, so this cannot cancel
   * queued or in-flight phone work.
   */
  async interruptObsoleteOutput(): Promise<
    ObsoleteOutputInterruptionResultV1
  > {
    const [, cancelled] = await Promise.all([
      Promise.resolve(this.playback.stopPlayback()),
      this.response.cancelResponse(),
    ]);
    return {
      modelResponse: cancelled ? 'cancelled' : 'idle',
      phoneOperation: 'unchanged',
      sarvamPlayback: 'stopped',
      version: 1,
    };
  }

  async cancelTaskExplicitly(input: {
    controller: PhoneTaskCancellationController;
    taskId: LocalIdentifier<'task'>;
  }): Promise<unknown> {
    return input.controller.cancelTask(input.taskId);
  }
}
