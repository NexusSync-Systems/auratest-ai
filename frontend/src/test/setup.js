import '@testing-library/jest-dom/vitest';
import { vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom nemá scrollIntoView ani matchMedia — App.jsx obojí používá.
Element.prototype.scrollIntoView = vi.fn();

if (!window.matchMedia) {
  window.matchMedia = () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  });
}

// WebSocket se v testech nepřipojuje nikam ven.
class MockWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    MockWebSocket.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  send() {}
}
window.WebSocket = MockWebSocket;
globalThis.MockWebSocket = MockWebSocket;
