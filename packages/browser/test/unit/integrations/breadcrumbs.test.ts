import { getCurrentHub } from '@sentry/core';

import { Breadcrumbs, BrowserClient, flush, Hub } from '../../../src';
import { getDefaultBrowserClientOptions } from '../helper/browser-client-options';

const hub = new Hub();

jest.mock('@sentry/core', () => {
  const original = jest.requireActual('@sentry/core');
  return {
    ...original,
    getCurrentHub: () => hub,
  };
});

describe('Breadcrumbs', () => {
  it('Should add sentry breadcrumb', async () => {
    const addBreadcrumb = jest.fn();
    hub.addBreadcrumb = addBreadcrumb;

    const client = new BrowserClient({
      ...getDefaultBrowserClientOptions(),
      dsn: 'https://username@domain/123',
      integrations: [new Breadcrumbs()],
    });

    getCurrentHub().bindClient(client);

    client.captureMessage('test');
    await flush(2000);

    expect(addBreadcrumb.mock.calls[0][0].category).toEqual('sentry.event');
    expect(addBreadcrumb.mock.calls[0][0].message).toEqual('test');
  });
});
