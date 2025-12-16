import { readFile } from 'node:fs/promises';

import fp from 'fastify-plugin';
import GracefulServer from '@gquittet/graceful-server';

import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync } from 'fastify';

// -------------------------------------------------------------------------------------------------
// Type Definitions
// -------------------------------------------------------------------------------------------------

/**
 * Useful to flatten the type output to improve type hints shown in editors.
 * And also to transform an interface into a type to aide with assignability.
 * @internal
 */
type Simplify<T> = { [KeyType in keyof T]: T[KeyType] } & {};

/**
 * Defines the possible runtime environments detected by `@zahoor/fastify-gracely`.
 *
 * - `'none'` – disable all Gracely detection and hooks.
 * - `'auto'` – automatically detect runtime.
 * - `'local'` – running on a local machine.
 * - `'container'` – running inside a container (Docker, Containerd, Podman).
 * - `'kubernetes'` – running inside a Kubernetes cluster.
 * @internal
 */
type GracelyRuntime = 'none' | 'auto' | 'local' | 'container' | 'kubernetes';

/**
 * Defines the structure for customizing the default log messages
 * outputted during server lifecycle events (Ready and Close).
 * @internal
 */
type GracelyLogger = {
  /**
   * Custom message logged when the server is marked as ready (`READY`).
   *
   * Default is `Gracely: Server is ready ~~~`.
   */
  ready: string;

  /**
   * Custom message logged when the server begins shutting down (`SHUTTING_DOWN`).
   *
   * Default is `Gracely: Server is closed !!!`.
   */
  close: string;
};

/**
 * Type representing the complete, resolved configuration bundle for logging.
 * This bundle is created by {@link resolveLoggerOptions} and contains the log instance
 * and all default or customized messages needed by the plugin's lifecycle hooks.
 * @internal
 */
type ResolveLoggerMetadata = Simplify<
  GracelyLogger & {
    detect: string;
    log: FastifyBaseLogger;
  }
>;

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

  /**
   * Logging configuration options for the server lifecycle events.
   *
   * Default is `true`.
   *
   * - `boolean`: Enables or disables the default logging using `fastify.log.info`.
   * - `true`: Logs default messages.
   * - `false`: Disables ready/close logging entirely.
   * - `Partial<GracelyLogger>`: Overrides the default `ready` or `close` message strings.
   *
   * @example
   * // To customize only the ready message:
   * logger: { ready: 'Application is online!' }
   */
  logger?: boolean | Partial<GracelyLogger>;
}

/**
 * Internal plugin type signature used by Fastify.
 * @internal
 */
type FastifyGracelyPlugin = FastifyPluginAsync<NonNullable<FastifyGracelyOptions>>;

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
async function detectGracelyRuntime(options: Pick<FastifyGracelyOptions, 'containerEndpoint'>): Promise<Exclude<GracelyRuntime, 'auto' | 'none'>> {
  // 1. K8s
  if (process.env.KUBERNETES_SERVICE_HOST || process.env.K8S === 'true') {
    return 'kubernetes';
  }

  // 2. Container environment（Docker / Containerd / Podman）
  if (options.containerEndpoint) {
    try {
      const content = await readFile(options.containerEndpoint, 'utf8');
      if (/docker|kubepods|containerd|libpod/i.test(content)) {
        return 'container';
      }
    } catch {
      // ...ignore
    }
  }

  return 'local';
}

/**
 * Parses and resolves the 'logger' option from user input into a standardized
 * configuration bundle (log instance + resolved messages) for internal use.
 * @internal
 */
function resolveLoggerOptions(options: Pick<FastifyGracelyOptions, 'logger'>, fastify: FastifyInstance): ResolveLoggerMetadata | undefined {
  if (options.logger === false || options.logger === undefined) {
    return undefined;
  }

  const ready = 'Gracely: Server is ready ~~~';
  const close = 'Gracely: Server is closed !!!';
  const detect = 'Gracely: Server gracely env is "%s"';

  const log = fastify.log;

  if (options.logger === true) {
    return { log, ready, close, detect };
  }

  return {
    log,
    ready: options.logger.ready ?? ready,
    close: options.logger.close ?? close,
    detect
  };
}

/**
 * Registers the 'gracely' object as a decorator on the Fastify instance and Request.
 *
 * This function handles both the fully-functional (Kubernetes/Local) mode
 * and the disabled ('none') mode by setting the appropriate runtime string and
 * readiness function.
 *
 * @param fastify - The Fastify instance to decorate.
 * @param runtime - The detected or configured runtime environment (e.g., 'kubernetes', 'none').
 * @param ready - A function that returns the current readiness state of the server.
 * In 'none' mode, this should always return `false`.
 */
function setupFastifyGracely(fastify: FastifyInstance, runtime: GracelyRuntime, ready: () => boolean): void {
  const gracely = Object.freeze({ runtime, ready });
  fastify.decorate('gracely', { getter: () => gracely });
  fastify.decorateRequest('gracely', { getter: () => gracely });
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
 * - Lifecycle hooks: `ready`, `close`, `error`.
 * - Exposes a `gracely` decorator on both Fastify instance and Request.
 */
const plugin: FastifyGracelyPlugin = async (fastify, opts) => {
  const {
    //
    runtime = 'auto',
    timeout = 10_000,
    livenessEndpoint = '/live',
    readinessEndpoint = '/ready',
    containerEndpoint = '/proc/1/cgroup',
    logger = true
  } = opts;

  const spec = resolveLoggerOptions({ logger }, fastify);

  if (runtime === 'none') {
    spec?.log.warn('Gracely disabled by options. (runtime: "none")');
    setupFastifyGracely(fastify, 'none', () => false);
    return;
  }

  const env: GracelyRuntime = runtime === 'auto' ? await detectGracelyRuntime({ containerEndpoint }) : runtime;

  spec?.log.info(spec.detect, env);

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

  setupFastifyGracely(fastify, env, () => graceful.isReady());

  // Lifecycle event hooks

  graceful.on(GracefulServer.READY, () => {
    if (typeof opts.ready === 'function') {
      opts.ready();
    }
    spec?.log.info(spec.ready);
  });

  graceful.on(GracefulServer.SHUTTING_DOWN, () => {
    if (typeof opts.close === 'function') {
      opts.close();
    }
    spec?.log.info(spec.close);
  });

  graceful.on(GracefulServer.SHUTDOWN, (error: Error) => {
    if (typeof opts.error === 'function') {
      opts.error(error);
    }
  });

  fastify.addHook('onReady', async () => {
    graceful.setReady();
  });
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
     * - `runtime`: Detected or configured runtime (`'none' | 'local' | 'container' | 'kubernetes'`)
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
