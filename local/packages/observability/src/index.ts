export interface EventSink { emit(name: string, attributes?: Readonly<Record<string, string>>): void }
export const noopEventSink: EventSink = { emit: (): void => undefined };