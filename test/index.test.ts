import fastify from 'fastify';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// import { fastifyGracely } from '../src/index';

import type { FastifyInstance } from 'fastify';

import type { FastifyGracelyOptions } from '../src/index';

// --------------------------------------------
// Mock
// --------------------------------------------

const mockReadFileSync = vi.fn();
vi.mock('node:fs', () => ({ readFileSync: mockReadFileSync }));

let listeners: Record<string, Function> = {};
const mockGracefulServer = {
  isReady: vi.fn(() => false),
  setReady: vi.fn(),
  on: vi.fn(function (event: string, listener: Function) {
    listeners[event] = listener;
    return this;
  })
};

const MockGracefulServer = vi.fn((server: any, opts: any) => {
  listeners = {};
  mockGracefulServer.isReady.mockClear().mockImplementation(() => false);
  mockGracefulServer.setReady.mockClear();
  return mockGracefulServer;
});

MockGracefulServer.READY = 'READY';
MockGracefulServer.SHUTTING_DOWN = 'SHUTTING_DOWN';
MockGracefulServer.SHUTDOWN = 'SHUTDOWN';

vi.mock('@gquittet/graceful-server', () => ({
  default: MockGracefulServer
}));

function reset() {
  vi.clearAllMocks();
  delete process.env.KUBERNETES_SERVICE_HOST;
  delete process.env.K8S;
}

const readyPost = async () => {
  mockGracefulServer.isReady.mockImplementation(() => true);
  if (listeners[MockGracefulServer.READY]) {
    listeners[MockGracefulServer.READY]();
  }
};

const gracelyClose = async () => {
  if (listeners[MockGracefulServer.SHUTTING_DOWN]) {
    listeners[MockGracefulServer.SHUTTING_DOWN]();
  }
  if (listeners[MockGracefulServer.SHUTDOWN]) {
    listeners[MockGracefulServer.SHUTDOWN](null);
  }
};

// --------------------------------------------
// Test case
// --------------------------------------------

// oxfmt-ignore
// prettier-ignore
async function setupServe(options: Partial<FastifyGracelyOptions> = {}, handlePreReady?: (instance: FastifyInstance) => void | Promise<void>, handlePostReady: () => void | Promise<void> = readyPost): Promise<FastifyInstance> {
  const instance = fastify();
  await instance.register(await import('../src/index'), options as any);
  await handlePreReady?.(instance);
  await instance.ready();
  await handlePostReady?.();
  return instance;
}

describe('@zahoor/fastify-gracely', () => {
  let serve: FastifyInstance;

  beforeEach(reset);

  afterEach(async () => {
    if (serve && serve.close) {
      gracelyClose();
      await serve.close();
    }
  });

  // --------------------------------------------
  // Fastify instance & request decoration
  // --------------------------------------------

  it('should decorate Fastify instance and request and confirm readiness', async () => {
    serve = await setupServe({ runtime: 'local' }, async instance => {
      instance.get('/check', (req, reply) => {
        expect(req.gracely.runtime).toBe('local');
        reply.send({ ready: req.gracely.ready() });
      });
    });

    expect(serve.gracely).toBeDefined();
    expect(serve.gracely.runtime).toBe('local');
    expect(serve.gracely.ready()).toBe(true);
    expect(mockGracefulServer.isReady).toHaveBeenCalled();

    const res = await serve.inject({ method: 'GET', url: '/check' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ready: true });
  });

  // --------------------------------------------
  // Runtime Detection Scenarios
  // --------------------------------------------

  it('should detect kubernetes (K8S=true) and configure GracefulServer', async () => {
    process.env.K8S = 'true';
    serve = await setupServe({ runtime: 'auto' });

    expect(serve.gracely.runtime).toBe('kubernetes');
    expect(mockReadFileSync).not.toHaveBeenCalled();

    const options = MockGracefulServer.mock.calls[0][1];
    expect(options).toMatchObject({ kubernetes: true, healthCheck: true });
  });

  it('should detect container via file read with custom endpoint', async () => {
    mockReadFileSync.mockReturnValue('content with containerd');
    serve = await setupServe({ runtime: 'auto', containerEndpoint: '/custom/cgroup' });

    expect(serve.gracely.runtime).toBe('container');
    expect(mockReadFileSync).toHaveBeenCalledWith('/custom/cgroup', 'utf8');
  });

  it('should default to local when containerEndpoint is ""', async () => {
    serve = await setupServe({ runtime: 'auto', containerEndpoint: '' });

    expect(mockReadFileSync).not.toHaveBeenCalled();
    expect(serve.gracely.runtime).toBe('local');
  });

  it('should default to local when file read fails (covers try-catch)', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('File error');
    });
    serve = await setupServe({ runtime: 'auto' });

    expect(serve.gracely.runtime).toBe('local');
    expect(mockReadFileSync).toHaveBeenCalled();
  });

  it('should respect manual runtime: "none"', async () => {
    serve = await setupServe({ runtime: 'none' });

    expect(serve.gracely.runtime).toBe('none');
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  // --------------------------------------------
  // Lifecycle hooks
  // --------------------------------------------

  it('should call ready hook and log readiness', async () => {
    const readySpied = vi.fn();
    serve = await setupServe({ ready: readySpied });

    expect(readySpied).toHaveBeenCalledTimes(1);
    expect(mockGracefulServer.setReady).toHaveBeenCalledTimes(1);
  });

  it('should call close hook and log shutdown', async () => {
    const closeSpied = vi.fn();
    serve = await setupServe({ close: closeSpied });

    gracelyClose();
    await serve.close();

    expect(closeSpied).toHaveBeenCalledTimes(1);

    delete listeners[MockGracefulServer.SHUTTING_DOWN];
    delete listeners[MockGracefulServer.SHUTDOWN];
  });

  it('should call error hook when SHUTDOWN event has an error', async () => {
    const errorSpied = vi.fn();
    serve = await setupServe({ error: errorSpied });

    const mockError = new Error('Force shutdown error');
    if (listeners[MockGracefulServer.SHUTDOWN]) {
      listeners[MockGracefulServer.SHUTDOWN](mockError);
    }

    expect(errorSpied).toHaveBeenCalledWith(mockError);

    delete listeners[MockGracefulServer.SHUTDOWN];
  });

  it('should handle optional closing hook (async cleanup)', async () => {
    const closingSpied = vi.fn().mockResolvedValue('cleanup done');

    serve = await setupServe({ closing: closingSpied });

    const options = MockGracefulServer.mock.calls[0][1];
    expect(options.closePromises).toHaveLength(1);

    await options.closePromises[0]();
    expect(closingSpied).toHaveBeenCalledTimes(1);
  });
});
