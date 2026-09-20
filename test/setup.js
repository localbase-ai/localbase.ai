import inject from 'light-my-request';
import { app } from '../tools/server/app-server.js';

/**
 * Test Setup - Provides in-process request helpers for API tests.
 *
 * Tests run directly against the Express app to avoid localhost socket
 * dependencies in restricted environments.
 */

export async function startTestServer() {
  // No setup required.
}

export async function stopTestServer() {
  // No teardown required.
}

export async function request(path, options = {}) {
  const { method = 'GET', body, headers = {} } = options;
  const response = await inject(app, {
    method,
    url: path,
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    payload: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = response.payload;

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return {
    status: response.statusCode,
    data,
    headers: new Headers(response.headers),
    rawHeaders: response.headers
  };
}
