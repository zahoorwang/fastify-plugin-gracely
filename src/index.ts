import { readFileSync } from 'node:fs';

import fp from 'fastify-plugin';
import GracefulServer from '@gquittet/graceful-server';

import type { FastifyPluginCallback } from 'fastify';

// -------------------------------------------------------------------------------------------------
// Type Definitions
// -------------------------------------------------------------------------------------------------

/**
 * Defines the possible runtime environments detected by `@zahoor/fastify-gracely`.
 *
 * - `'none'` – disable all Gracely detection and hooks.
 * - `'auto'` – automatically detect runtime.
 * - `'local'` – running on a local machine.
 * - `'container'` – running inside a container (Docker, Containerd, Podman).
 * - `'kubernetes'` – running inside a Kubernetes cluster.
 */
type GracelyRuntime = 'none' | 'auto' | 'local' | 'container' | 'kubernetes';

/**
 * Options for the `fastifyGracely` plugin.
 */
export interface FastifyGracelyOptions {
  /**
   * The runtime environment mode.
   * Defaults to `'auto'` for automatic detection.
   */
  runtime?: GracelyRuntime;

  /**
   * Timeout in milliseconds for graceful shutdown operations.
   * Default is `10_000`.
   */
  timeout?: number;

  /**
   * HTTP endpoint path for liveness probes.
   * Used in `Kubernetes` mode for health checks.
   * Default is `'/live'`.
   */
  livenessEndpoint?: string;

  /**
   * HTTP endpoint path for readiness probes.
   * Used in `Kubernetes` mode for health checks.
   * Default is `'/ready'`.
   */
  readinessEndpoint?: string;

  /**
   * Path to a container detection file, e.g., `'/proc/1/cgroup'`.
   * Used to detect container environments such as `Docker` or `Containerd`.
   */
  containerEndpoint?: string;

  /**
   * Callback invoked when the server is marked as ready (`READY`).
   */
  ready?: () => void;

  // /**
  //  * Callback invoked when the server is starting (`STARTING`).
  //  */
  // start?: () => void;

  /**
   * Callback invoked when the server is closing (`SHUTTING_DOWN`).
   */
  close?: () => void;

  /**
   * Callback invoked when shutdown is complete or an error occurs.
   */
  error?: (error: Error) => void;

  /**
   * Optional asynchronous hook to perform custom closing logic.
   * Can return a promise to delay shutdown completion.
   */
  closing?: () => Promise<unknown>;
}

/**
 * Internal plugin type signature used by Fastify.
 * @internal
 */
type FastifyGracelyPlugin = FastifyPluginCallback<NonNullable<FastifyGracelyOptions>>;

// -------------------------------------------------------------------------------------------------
// Runtime Detection
// -------------------------------------------------------------------------------------------------

/**
 * Detects the current runtime environment based on the container endpoint or environment variables.
 *
 * @param options.containerEndpoint - Path to a file indicating container environment.
 * @returns Detected runtime: `'local' | 'container' | 'kubernetes'`.
 * @internal
 */
function detectGracelyRuntime(options: Pick<FastifyGracelyOptions, 'containerEndpoint'>): Exclude<GracelyRuntime, 'auto' | 'none'> {
  // 1. K8s
  if (process.env.KUBERNETES_SERVICE_HOST || process.env.K8S === 'true') {
    return 'kubernetes';
  }

  // 2. Container environment（Docker / Containerd / Podman）
  if (options.containerEndpoint) {
    try {
      const content = readFileSync(options.containerEndpoint, 'utf8');
      if (/docker|kubepods|containerd|libpod/i.test(content)) {
        return 'container';
      }
    } catch {
      // ...ignore
    }
  }

  return 'local';
}

// -------------------------------------------------------------------------------------------------
// Plugin Implementation
// -------------------------------------------------------------------------------------------------

/**
 * A Fastify plugin that provides **graceful shutdown and health checks** integration.
 *
 * ### Features:
 * - Automatic runtime detection (`auto`) for local, container, or `Kubernetes`.
 * - Optional liveness and readiness HTTP endpoints.
 * - Lifecycle hooks: `ready`, `start`, `close`, `error`.
 * - Exposes a `gracely` decorator on both Fastify instance and Request.
 */
const plugin: FastifyGracelyPlugin = (fastify, opts, done) => {
  const {
    //
    runtime = 'auto',
    timeout = 10_000,
    livenessEndpoint = '/live',
    readinessEndpoint = '/ready',
    containerEndpoint = '/proc/1/cgroup'
  } = opts;

  const env: GracelyRuntime = runtime === 'auto' ? detectGracelyRuntime({ containerEndpoint }) : runtime;

  const isKubernetes = env === 'kubernetes';

  const graceful = GracefulServer(fastify.server, {
    timeout,
    syncClose: false,
    closePromises: typeof opts.closing === 'function' ? [opts.closing] : [],
    healthCheck: isKubernetes,
    kubernetes: isKubernetes,
    livenessEndpoint,
    readinessEndpoint
  });

  // Decorated object exposed on Fastify instance and Request.
  const gracely = Object.freeze({
    // Detected or configured runtime environment.
    runtime: env,
    // Returns whether the server is marked as ready.
    ready() {
      return graceful.isReady();
    }
  });

  fastify.decorate('gracely', { getter: () => gracely });
  fastify.decorateRequest('gracely', { getter: () => gracely });

  // Lifecycle event hooks

  // graceful.on(GracefulServer.STARTING, () => {
  //   if (typeof opts.start === 'function') {
  //     opts.start();
  //   }
  // });

  graceful.on(GracefulServer.READY, () => {
    if (typeof opts.ready === 'function') {
      opts.ready();
    }
    fastify.log.info('Server is ready ...');
  });

  graceful.on(GracefulServer.SHUTTING_DOWN, () => {
    if (typeof opts.close === 'function') {
      opts.close();
    }
    fastify.log.info('Server is closed !!!');
  });

  graceful.on(GracefulServer.SHUTDOWN, (error: Error) => {
    if (typeof opts.error === 'function') {
      opts.error(error);
    }
  });

  fastify.addHook('onReady', async () => {
    graceful.setReady();
  });

  done();
};

/**
 * The Fastify plugin that integrates the [`@gquittet/graceful-server`](https://github.com/gquittet/graceful-server) system.
 *
 * It decorates both `FastifyInstance` and `FastifyRequest` with a `gracely` object.
 */
export const fastifyGracely = fp(plugin, {
  fastify: '5.x',
  name: '@zahoor/fastify-gracely'
});

export default fastifyGracely;

// -------------------------------------------------------------------------------------------------
// Fastify Type Augmentation
// -------------------------------------------------------------------------------------------------

/**
 * Extends Fastify built-in types to expose the `gracely` API.
 *
 * The `gracely` object provides runtime detection information
 * and readiness state for the Fastify server, usable both at the
 * server level (`FastifyInstance`) and per-request (`FastifyRequest`).
 *
 * Example usage:
 * ```ts
 * // Server level
 * if (fastify.gracely.ready()) {
 *   console.log('Server is ready on runtime:', fastify.gracely.runtime);
 * }
 *
 * // Request level
 * fastify.get('/status', async (req) => {
 *   if (req.gracely.ready()) {
 *     return { status: 'ready', runtime: req.gracely.runtime };
 *   }
 *   return { status: 'starting' };
 * });
 * ```
 */
declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Provides information about the runtime environment and readiness state.
     *
     * Properties:
     * - `runtime`: Detected or configured runtime (`'none' | 'auto' | 'local' | 'container' | 'kubernetes'`)
     * - `ready()`: Returns `true` if the server is marked as ready
     */
    gracely: {
      /**
       * Detected or configured runtime environment.
       */
      readonly runtime: GracelyRuntime;

      /**
       * Returns `true` if the server is marked ready.
       */
      ready(): boolean;
    };
  }

  interface FastifyRequest {
    /**
     * Exposes the same `gracely` API as FastifyInstance, for per-request usage.
     *
     * Useful for middleware, route handlers, and custom health checks
     * that need runtime or readiness information.
     */
    gracely: {
      /**
       * Detected or configured runtime environment.
       */
      readonly runtime: GracelyRuntime;

      /**
       * Returns `true` if the server is marked ready.
       */
      ready(): boolean;
    };
  }
}
