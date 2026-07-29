let queueTail: Promise<void> = Promise.resolve();

export const runPublicCartTurn = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = queueTail.then(operation, operation);
  queueTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};
