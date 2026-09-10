export const defaultRemoteConcurrency = 3;
export const minimumRemoteConcurrency = 1;
export const maximumRemoteConcurrency = 10;

export function validRemoteConcurrency(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= minimumRemoteConcurrency &&
    Number(value) <= maximumRemoteConcurrency;
}
