# Deployment

This directory contains platform-specific deployment configurations. Each subdirectory targets a particular hosting environment.

| Directory | Description |
|-----------|-------------|
| `permaship/` | PermaShip production deployment on AWS ECS Fargate |

## Writing Your Own Deployment

The Agents system is a standard Node.js application. At its core, deployment requires:

1. A PostgreSQL database
2. The environment variables described in `../.env.example`
3. A container or process running `node dist/src/index.js` (or `npm start`)

The generic `Dockerfile` in the project root builds a production image that works anywhere. Use it as a starting point for your own deployment, or run the app directly with `npm start`.

For adapter configuration, set `ADAPTER_PROFILE` to the name of your adapter profile (or leave it as `default` for standalone mode). See `../src/adapters/loader.ts` for how profiles are resolved.
