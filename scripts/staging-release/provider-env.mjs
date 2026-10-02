import { StagingReleaseError } from './errors.mjs'

/** Pinned Distilled HTTP serializers/parsers log raw request/response bodies when this family is set.
 * Check each source separately: .env.local must not mask a dangerous inherited value (or vice versa).
 * Even empty/"0" settings refuse; the release does not silently reinterpret a requested debug mode.
 */
export function assertSafeProviderEnv(...sources) {
  if (sources.some(env => Object.keys(env).some(name => name.startsWith('DISTILLED_DEBUG') && env[name] !== undefined)))
    throw new StagingReleaseError('guard-debug-env-set')
}
