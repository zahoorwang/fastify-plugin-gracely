# @zahoor/fastify-gracely

[![NPM version](https://img.shields.io/npm/v/@zahoor/fastify-gracely?style=for-the-badge)](https://www.npmjs.com/package/@zahoor/fastify-gracely)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)
[![Coverage Status](https://img.shields.io/badge/coverage-100%25-brightgreen?style=for-the-badge)]()

> **The current version has not been fully tested and is considered unstable; DO NOT USE.**

A robust solution for Graceful Shutdown and Health Checks in [Fastify](http://fastify.dev/) applications.

This plugin wraps [@gquittet/graceful-server](https://github.com/gquittet/graceful-server) and provides automatic runtime environment detection, ensuring your service deploys and shuts down securely and stably, especially within containerized and Kubernetes environments.

## Features

- **Graceful Shutdown**: Listens for process signals (like `SIGTERM`), allowing active connections to complete before safely terminating the server.
- **Automatic Runtime Detection**: Automatically identifies `local`, `container`, and `kubernetes` environments.
- **Kubernetes Support**: Automatically registers Liveness (`/live`) and Readiness (`/ready`) HTTP probes when running in a K8s cluster.
- **Lifecycle Hooks**: Provides `ready`, `close`, and the asynchronous `closing` hook for custom cleanup logic.
- **Status Decorator**: Exposes the runtime environment and readiness status via `fastify.gracely` and `request.gracely`.

## Install

```sh
npm i @zahoor/fastify-gracely
```

### Compatibility

| Plugin version | `Fastify` version | `@gquittet/graceful-server` version |
| -------------- | ----------------- | ----------------------------------- |
| `current`      | `^5.x`            | `^6.x`                              |

## Usage

```ts
import fastify from 'fastify';
import gracely from '@zahoor/fastify-gracely';

const serve = fastify();

serve.register(gracely, {
  // Graceful shutdown timeout (Default: 10_000ms)
  timeout: 5000,

  // [Optional] Asynchronous hook: Perform cleanup tasks (e.g., closing DB connections)
  // that can delay the shutdown completion.
  closing: async () => {
    fastify.log.info('Executing asynchronous cleanup before shutdown...');
    // await db.close();
  },

  // [Optional] Triggered when the server is marked as READY.
  ready: () => {
    fastify.log.info('Application is fully READY!');
  },

  // [Optional] Triggered when the server starts shutting down (SHUTTING_DOWN).
  close: () => {
    fastify.log.warn('Server is starting graceful shutdown...');
  },

  // [Optional] Triggered when shutdown is complete or an error occurs.
  error: err => {
    fastify.log.error('Shutdown completed with an error:', err);
  }
});

await serve.listen({ port: 3000 });
```

## Options

- `runtime` (`'none' | 'auto' | 'local' | 'container' | 'kubernetes'`, default: `'auto'`): The **runtime environment mode**. Use `'auto'` for automatic detection. Setting it manually overrides detection.
- `timeout` (`number`, default: `10_000`): **Timeout in milliseconds** for the graceful shutdown process to complete.
- `livenessEndpoint` (`string`, default: `'/live'`): HTTP path for **liveness probes** (only enabled in '`kubernetes'` mode).
- `readinessEndpoint` (`string`, default: `'/ready'`): HTTP path for **readiness probes** (only enabled in `'kubernetes'` mode).
- `containerEndpoint` (`string`, default: `'/proc/1/cgroup'`): The file path used by the automatic detector to check for **container environments**.
- `closing` (`() => Promise<unknown>`, default: `undefined`): An **asynchronous** hook for custom cleanup logic (e.g., closing database connections). This delays the shutdown completion.
- `ready` (`() => void`, default: `undefined`): Callback invoked when the server is marked as ready (`READY`).
- `close` (`() => void`, default: `undefined`): Callback invoked when the server starts closing (`SHUTTING_DOWN`).
- `error` (`(error: Error) => void`, default: `undefined`): Callback invoked when shutdown is complete, including when a fatal error occurs.

## Runtime Environment Detection Logic

When `runtime: 'auto'`, the plugin detects the environment in the following order:

1. **kubernetes**: Checks for the environment variables `KUBERNETES_SERVICE_HOST` or `K8S === 'true'`.
2. **container**: Attempts to read the file at `containerEndpoint` (default `/proc/1/cgroup`) and matches against keywords like `docker`, `kubepods`, `containerd`, etc.
3. **local**: Used as the fallback if neither of the above conditions is met.

## Integration with Kubernetes

> **Don't forget to enable the kubernetes mode.**

```yml
readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  failureThreshold: 1
  initialDelaySeconds: 5
  periodSeconds: 5
  successThreshold: 1
  timeoutSeconds: 5
livenessProbe:
  httpGet:
    path: /live
    port: 8080
  failureThreshold: 3
  initialDelaySeconds: 10
  # Allow sufficient amount of time (90 seconds = periodSeconds * failureThreshold)
  # for the registered shutdown handlers to run to completion.
  periodSeconds: 30
  successThreshold: 1
  # Setting a very low timeout value (e.g. 1 second) can cause false-positive
  # checks and service interruption.
  timeoutSeconds: 5

# As per Kubernetes documentation (https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#when-should-you-use-a-startup-probe),
# startup probe should point to the same endpoint as the liveness probe.
#
# Startup probe is only needed when container is taking longer to start than
# `initialDelaySeconds + failureThreshold × periodSeconds` of the liveness probe.
startupProbe:
  httpGet:
    path: /live
    port: 8080
  failureThreshold: 3
  initialDelaySeconds: 10
  periodSeconds: 30
  successThreshold: 1
  timeoutSeconds: 5
```

## License

Licensed under [MIT](./LICENSE).
