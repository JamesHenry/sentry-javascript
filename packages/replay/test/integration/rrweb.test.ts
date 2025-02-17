import { resetSdkMock } from '../mocks/resetSdkMock';
import { useFakeTimers } from '../utils/use-fake-timers';

useFakeTimers();

describe('Integration | rrweb', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('calls rrweb.record with custom options', async () => {
    const { mockRecord } = await resetSdkMock({
      replayOptions: {
        ignore: ['.sentry-test-ignore'],
        stickySession: false,
      },
    });
    expect(mockRecord.mock.calls[0][0]).toMatchInlineSnapshot(`
      Object {
        "blockSelector": ".sentry-block,[data-sentry-block],img,image,svg,path,rect,area,video,object,picture,embed,map,audio",
        "collectFonts": true,
        "emit": [Function],
        "ignoreSelector": ".sentry-test-ignore,.sentry-ignore,[data-sentry-ignore]",
        "inlineImages": false,
        "inlineStylesheet": true,
        "maskAllInputs": true,
        "maskInputFn": undefined,
        "maskInputOptions": Object {
          "password": true,
        },
        "maskInputSelector": ".sentry-mask,[data-sentry-mask]",
        "maskTextFn": undefined,
        "maskTextSelector": "body *:not(style), body *:not(script)",
        "slimDOMOptions": "all",
        "unblockSelector": ".sentry-unblock,[data-sentry-unblock]",
        "unmaskInputSelector": ".sentry-unmask,[data-sentry-unmask]",
        "unmaskTextSelector": ".sentry-unmask,[data-sentry-unmask]",
      }
    `);
  });
});
