import type {
  Envelope,
  EventEnvelope,
  EventItem,
  InternalBaseTransportOptions,
  ReplayEnvelope,
  ReplayEvent,
  Transport,
  TransportMakeRequestResponse,
} from '@sentry/types';
import {
  createEnvelope,
  createEventEnvelopeHeaders,
  dsnFromString,
  getSdkMetadataForEnvelopeHeader,
} from '@sentry/utils';
import { TextEncoder } from 'util';

import { createTransport } from '../../../src';
import type { CreateOfflineStore, OfflineTransportOptions } from '../../../src/transports/offline';
import { makeOfflineTransport, MIN_DELAY, START_DELAY } from '../../../src/transports/offline';

const ERROR_ENVELOPE = createEnvelope<EventEnvelope>({ event_id: 'aa3ff046696b4bc6b609ce6d28fde9e2', sent_at: '123' }, [
  [{ type: 'event' }, { event_id: 'aa3ff046696b4bc6b609ce6d28fde9e2' }] as EventItem,
]);

const REPLAY_EVENT: ReplayEvent = {
  // @ts-ignore private api
  type: 'replay_event',
  timestamp: 1670837008.634,
  error_ids: ['errorId'],
  trace_ids: ['traceId'],
  urls: ['https://example.com'],
  replay_id: 'MY_REPLAY_ID',
  segment_id: 3,
  replay_type: 'error',
};

const DSN = dsnFromString('https://public@dsn.ingest.sentry.io/1337');

const DATA = 'nothing';

const RELAY_ENVELOPE = createEnvelope<ReplayEnvelope>(
  createEventEnvelopeHeaders(REPLAY_EVENT, getSdkMetadataForEnvelopeHeader(REPLAY_EVENT), undefined, DSN),
  [
    [{ type: 'replay_event' }, REPLAY_EVENT],
    [
      {
        type: 'replay_recording',
        length: DATA.length,
      },
      DATA,
    ],
  ],
);

const transportOptions = {
  recordDroppedEvent: () => undefined, // noop
  textEncoder: new TextEncoder(),
};

type MockResult<T> = T | Error;

const createTestTransport = (
  ...sendResults: MockResult<TransportMakeRequestResponse>[]
): { getSendCount: () => number; baseTransport: (options: InternalBaseTransportOptions) => Transport } => {
  let sendCount = 0;

  return {
    getSendCount: () => sendCount,
    baseTransport: (options: InternalBaseTransportOptions) =>
      createTransport(options, () => {
        return new Promise((resolve, reject) => {
          const next = sendResults.shift();

          if (next instanceof Error) {
            reject(next);
          } else {
            sendCount += 1;
            resolve(next as TransportMakeRequestResponse | undefined);
          }
        });
      }),
  };
};

type StoreEvents = ('add' | 'pop')[];

function createTestStore(...popResults: MockResult<Envelope | undefined>[]): {
  getCalls: () => StoreEvents;
  store: CreateOfflineStore;
} {
  const calls: StoreEvents = [];

  return {
    getCalls: () => calls,
    store: (_: OfflineTransportOptions) => ({
      insert: async env => {
        if (popResults.length < 30) {
          popResults.push(env);
          calls.push('add');
        }
      },
      pop: async () => {
        calls.push('pop');
        const next = popResults.shift();

        if (next instanceof Error) {
          throw next;
        }

        return next;
      },
    }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('makeOfflineTransport', () => {
  it('Sends envelope and checks the store for further envelopes', async () => {
    const { getCalls, store } = createTestStore();
    const { getSendCount, baseTransport } = createTestTransport({ statusCode: 200 });
    let queuedCount = 0;
    const transport = makeOfflineTransport(baseTransport)({
      ...transportOptions,
      createStore: store,
      shouldStore: () => {
        queuedCount += 1;
        return true;
      },
    });
    const result = await transport.send(ERROR_ENVELOPE);

    expect(result).toEqual({ statusCode: 200 });
    expect(queuedCount).toEqual(0);
    expect(getSendCount()).toEqual(1);

    await delay(MIN_DELAY * 2);

    // After a successful send, the store should be checked
    expect(getCalls()).toEqual(['pop']);
  });

  it('After successfully sending, sends further envelopes found in the store', async () => {
    const { getCalls, store } = createTestStore(ERROR_ENVELOPE);
    const { getSendCount, baseTransport } = createTestTransport({ statusCode: 200 }, { statusCode: 200 });
    const transport = makeOfflineTransport(baseTransport)({ ...transportOptions, createStore: store });
    const result = await transport.send(ERROR_ENVELOPE);

    expect(result).toEqual({ statusCode: 200 });

    await delay(MIN_DELAY * 3);

    expect(getSendCount()).toEqual(2);
    // After a successful send from the store, the store should be checked again to ensure it's empty
    expect(getCalls()).toEqual(['pop', 'pop']);
  });

  it('Queues envelope if wrapped transport throws error', async () => {
    const { getCalls, store } = createTestStore();
    const { getSendCount, baseTransport } = createTestTransport(new Error());
    let queuedCount = 0;
    const transport = makeOfflineTransport(baseTransport)({
      ...transportOptions,
      createStore: store,
      shouldStore: () => {
        queuedCount += 1;
        return true;
      },
    });
    const result = await transport.send(ERROR_ENVELOPE);

    expect(result).toEqual({});

    await delay(MIN_DELAY * 2);

    expect(getSendCount()).toEqual(0);
    expect(queuedCount).toEqual(1);
    expect(getCalls()).toEqual(['add']);
  });

  it('Does not queue envelopes if status code >= 400', async () => {
    const { getCalls, store } = createTestStore();
    const { getSendCount, baseTransport } = createTestTransport({ statusCode: 500 });
    let queuedCount = 0;
    const transport = makeOfflineTransport(baseTransport)({
      ...transportOptions,
      createStore: store,
      shouldStore: () => {
        queuedCount += 1;
        return true;
      },
    });
    const result = await transport.send(ERROR_ENVELOPE);

    expect(result).toEqual({ statusCode: 500 });

    await delay(MIN_DELAY * 2);

    expect(getSendCount()).toEqual(1);
    expect(queuedCount).toEqual(0);
    expect(getCalls()).toEqual([]);
  });

  it(
    'Retries sending envelope after failure',
    async () => {
      const { getCalls, store } = createTestStore();
      const { getSendCount, baseTransport } = createTestTransport(new Error(), { statusCode: 200 });
      const transport = makeOfflineTransport(baseTransport)({ ...transportOptions, createStore: store });
      const result = await transport.send(ERROR_ENVELOPE);
      expect(result).toEqual({});
      expect(getCalls()).toEqual(['add']);

      await delay(START_DELAY + 1_000);

      expect(getSendCount()).toEqual(1);
      expect(getCalls()).toEqual(['add', 'pop', 'pop']);
    },
    START_DELAY + 2_000,
  );

  it(
    'When enabled, sends envelopes found in store shortly after startup',
    async () => {
      const { getCalls, store } = createTestStore(ERROR_ENVELOPE, ERROR_ENVELOPE);
      const { getSendCount, baseTransport } = createTestTransport({ statusCode: 200 }, { statusCode: 200 });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _transport = makeOfflineTransport(baseTransport)({
        ...transportOptions,
        createStore: store,
        flushAtStartup: true,
      });

      await delay(START_DELAY + 1_000);

      expect(getSendCount()).toEqual(2);
      expect(getCalls()).toEqual(['pop', 'pop', 'pop']);
    },
    START_DELAY + 2_000,
  );

  it('shouldStore can stop envelopes from being stored on send failure', async () => {
    const { getCalls, store } = createTestStore();
    const { getSendCount, baseTransport } = createTestTransport(new Error());
    const queuedCount = 0;
    const transport = makeOfflineTransport(baseTransport)({
      ...transportOptions,
      createStore: store,
      shouldStore: () => false,
    });
    const result = transport.send(ERROR_ENVELOPE);

    await expect(result).rejects.toBeInstanceOf(Error);
    expect(queuedCount).toEqual(0);
    expect(getSendCount()).toEqual(0);
    expect(getCalls()).toEqual([]);
  });

  it('should not store Relay envelopes on send failure', async () => {
    const { getCalls, store } = createTestStore();
    const { getSendCount, baseTransport } = createTestTransport(new Error());
    const queuedCount = 0;
    const transport = makeOfflineTransport(baseTransport)({
      ...transportOptions,
      createStore: store,
      shouldStore: () => true,
    });
    const result = transport.send(RELAY_ENVELOPE);

    await expect(result).rejects.toBeInstanceOf(Error);
    expect(queuedCount).toEqual(0);
    expect(getSendCount()).toEqual(0);
    expect(getCalls()).toEqual([]);
  });

  it('Follows the Retry-After header', async () => {
    const { getCalls, store } = createTestStore(ERROR_ENVELOPE);
    const { getSendCount, baseTransport } = createTestTransport(
      {
        statusCode: 429,
        headers: { 'x-sentry-rate-limits': '', 'retry-after': '3' },
      },
      { statusCode: 200 },
    );

    let queuedCount = 0;
    const transport = makeOfflineTransport(baseTransport)({
      ...transportOptions,
      createStore: store,
      shouldStore: () => {
        queuedCount += 1;
        return true;
      },
    });
    const result = await transport.send(ERROR_ENVELOPE);

    expect(result).toEqual({
      statusCode: 429,
      headers: { 'x-sentry-rate-limits': '', 'retry-after': '3' },
    });

    await delay(MIN_DELAY * 2);

    expect(getSendCount()).toEqual(1);

    await delay(4_000);

    expect(getSendCount()).toEqual(2);
    expect(queuedCount).toEqual(0);
    expect(getCalls()).toEqual(['pop', 'pop']);
  }, 7_000);
});
