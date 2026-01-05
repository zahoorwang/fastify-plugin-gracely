import fastify from 'fastify';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { name } from '../package.json' with { type: 'json' };

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import type { FastifyGracelyOptions } from '../src/index';

// --------------------------------------------
// Mock
// --------------------------------------------

const mockReadFile = vi.fn();
vi.mock('node:fs/promises', () => ({ readFile: mockReadFile }));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  silent: vi.fn(),
  child: vi.fn(() => mockLogger)
} as unknown as FastifyBaseLogger;

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

  mockLogger.info.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
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
  const instance = fastify({ loggerInstance: mockLogger });
  await instance.register(await import('../src/index'), options as any);
  await handlePreReady?.(instance);
  await instance.ready();
  await handlePostReady?.();
  return instance;
}

describe(`plugin: ${name}`, () => {
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

    const reply = await serve.inject({ method: 'GET', url: '/check' });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ ready: true });
  });

  // --------------------------------------------
  // Runtime Detection Scenarios
  // --------------------------------------------

  it('should correctly handle runtime: "none" (skip init, set state, log warning)', async () => {
    MockGracefulServer.mockClear();

    serve = await setupServe({ runtime: 'none' }, undefined, () => {});

    expect(MockGracefulServer).not.toHaveBeenCalled();
    expect(serve.gracely.runtime).toBe('none');
    expect(serve.gracely.ready()).toBe(false);

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith('Gracely disabled by options. (runtime: "none")');
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('should detect kubernetes (K8S=true) and configure GracefulServer', async () => {
    process.env.K8S = 'true';
    serve = await setupServe({ runtime: 'auto' });

    expect(serve.gracely.runtime).toBe('kubernetes');
    expect(mockReadFile).not.toHaveBeenCalled();

    const options = MockGracefulServer.mock.calls[0][1];
    expect(options).toMatchObject({ kubernetes: true, healthCheck: true });
  });

  it('should detect container via file read with custom endpoint', async () => {
    mockReadFile.mockReturnValue('content with containerd');
    serve = await setupServe({ runtime: 'auto', containerEndpoint: '/custom/cgroup' });

    expect(serve.gracely.runtime).toBe('container');
    expect(mockReadFile).toHaveBeenCalledWith('/custom/cgroup', 'utf8');
  });

  it('should default to local when containerEndpoint is ""', async () => {
    serve = await setupServe({ runtime: 'auto', containerEndpoint: '' });

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(serve.gracely.runtime).toBe('local');
  });

  it('should default to local when file read fails (covers try-catch)', async () => {
    mockReadFile.mockImplementation(() => {
      throw new Error('File error');
    });
    serve = await setupServe({ runtime: 'auto' });

    expect(serve.gracely.runtime).toBe('local');
    expect(mockReadFile).toHaveBeenCalled();
  });

  it('should respect manual runtime: "none"', async () => {
    serve = await setupServe({ runtime: 'none' });

    expect(serve.gracely.runtime).toBe('none');
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  // --------------------------------------------
  // Logging Scenarios
  // --------------------------------------------

  it('should use default logger: true messages for Detection, READY and SHUTDOWN', async () => {
    serve = await setupServe({ runtime: 'local', logger: true });

    expect(mockLogger.info).toHaveBeenCalledWith('Gracely: Server env is "%s"', 'local');

    await readyPost();
    expect(mockLogger.info).toHaveBeenCalledWith('Gracely: Server is ready ~~~');

    await gracelyClose();
    await serve.close();
    expect(mockLogger.info).toHaveBeenCalledWith('Gracely: Server is closed !!!');

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('should use custom log messages', async () => {
    const readySpied = 'App is online now.';
    const closeSpied = 'App is going offline.';

    serve = await setupServe({
      runtime: 'local',
      logger: { ready: readySpied, close: closeSpied }
    });

    expect(mockLogger.info).toHaveBeenCalledWith('Gracely: Server env is "%s"', 'local');

    await readyPost();
    expect(mockLogger.info).toHaveBeenCalledWith(readySpied);

    await gracelyClose();
    await serve.close();
    expect(mockLogger.info).toHaveBeenCalledWith(closeSpied);
  });

  it('should suppress all logging when logger is false', async () => {
    serve = await setupServe({ runtime: 'local', logger: false });

    // 1. 检测日志应该被禁用
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();

    // 2. 模拟 READY event
    await readyPost();
    expect(mockLogger.info).not.toHaveBeenCalled();

    // 3. 模拟 SHUTDOWN event
    await gracelyClose();
    await serve.close();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  // --------------------------------------------
  // Lifecycle Hooks
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
