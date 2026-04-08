/**
 * Plugin Loader for NanoClaw
 * Reads plugin manifests, checks prerequisites, resolves active plugins
 * into aggregated hooks for the container runner.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import capabilities from './capabilities.config.js';
import { logger } from './logger.js';
import {
  CapabilitiesConfig,
  ContainerConfig,
  PluginManifest,
  PluginMount,
  PluginPrerequisite,
  PluginStatus,
  ResolvedPluginHooks,
} from './types.js';

const PLUGINS_DIR = path.join(process.cwd(), 'plugins');

function expandTilde(p: string): string {
  const homeDir = process.env.HOME || os.homedir();
  if (p.startsWith('~/')) return path.join(homeDir, p.slice(2));
  if (p === '~') return homeDir;
  return p;
}

let cachedManifests: PluginManifest[] | null = null;
let cachedCapabilities: CapabilitiesConfig | null = null;

/**
 * Load all plugin manifests from the plugins/ directory.
 */
export function loadPluginManifests(): PluginManifest[] {
  if (cachedManifests) return cachedManifests;

  const manifests: PluginManifest[] = [];

  if (!fs.existsSync(PLUGINS_DIR)) {
    cachedManifests = manifests;
    return manifests;
  }

  // Read in sorted order for deterministic processing
  const dirs = fs.readdirSync(PLUGINS_DIR).sort();
  for (const dir of dirs) {
    const manifestPath = path.join(PLUGINS_DIR, dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest: PluginManifest = JSON.parse(
        fs.readFileSync(manifestPath, 'utf-8'),
      );
      manifests.push(manifest);
    } catch (err) {
      logger.warn({ plugin: dir, err }, 'Failed to parse plugin manifest');
    }
  }

  cachedManifests = manifests;
  logger.info(
    { count: manifests.length, plugins: manifests.map((m) => m.name) },
    'Loaded plugin manifests',
  );
  return manifests;
}

/**
 * Load the capabilities config from the compiled capabilities.config.ts.
 * Type-safe: all plugin names are checked at compile time.
 */
export function loadCapabilitiesConfig(): CapabilitiesConfig {
  if (cachedCapabilities) return cachedCapabilities;

  cachedCapabilities = capabilities;
  logger.info(
    { capabilities: cachedCapabilities },
    'Loaded capabilities config',
  );
  return cachedCapabilities;
}

/**
 * Check whether a single prerequisite is satisfied.
 */
export function checkPrerequisite(prereq: PluginPrerequisite): {
  ok: boolean;
  reason?: string;
} {
  switch (prereq.type) {
    case 'file': {
      const expanded = expandTilde(prereq.path);
      if (fs.existsSync(expanded)) return { ok: true };
      return { ok: false, reason: `File not found: ${prereq.path}` };
    }
    case 'env': {
      if (process.env[prereq.path] !== undefined) return { ok: true };
      return {
        ok: false,
        reason: `Environment variable not set: ${prereq.path}`,
      };
    }
    case 'command': {
      try {
        execSync(`command -v ${prereq.path}`, { stdio: 'pipe' });
        return { ok: true };
      } catch {
        return { ok: false, reason: `Command not found: ${prereq.path}` };
      }
    }
    default:
      return { ok: false, reason: `Unknown prerequisite type: ${prereq.type}` };
  }
}

/**
 * Get the full status of all plugins.
 */
export function getPluginStatuses(): PluginStatus[] {
  const manifests = loadPluginManifests();
  const capabilities = loadCapabilitiesConfig();

  return manifests.map((manifest) => {
    const enabled =
      capabilities[manifest.name as keyof CapabilitiesConfig] ?? false;

    const failedPrerequisites: PluginStatus['failedPrerequisites'] = [];

    if (enabled) {
      manifest.prerequisites.forEach((prereq, index) => {
        const result = checkPrerequisite(prereq);
        if (!result.ok) {
          failedPrerequisites.push({
            index,
            prerequisite: prereq,
            reason: result.reason || 'Unknown',
          });
        }
      });
    }

    return {
      name: manifest.name,
      enabled,
      ready: enabled && failedPrerequisites.length === 0,
      failedPrerequisites,
      setupInstructions: manifest.setupInstructions,
    };
  });
}

/**
 * Resolve all active (enabled + ready) plugins into aggregated hooks.
 * Accepts optional per-group containerConfig for DB-level overrides.
 */
export function resolveActivePlugins(
  containerConfig?: ContainerConfig,
): ResolvedPluginHooks {
  const manifests = loadPluginManifests();
  const caps = loadCapabilitiesConfig();
  const dbCapabilities = containerConfig?.capabilities || {};

  const hooks: ResolvedPluginHooks = {
    mounts: [],
    envVars: {},
    entrypointCommands: [],
    mcpServers: {},
    allowedTools: [],
    skills: [],
    worktreesEnabled: false,
  };

  const mountedPaths = new Set<string>();

  for (const manifest of manifests) {
    // Merge: capabilities config → DB overrides
    const configEnabled =
      caps[manifest.name as keyof CapabilitiesConfig] ?? false;
    const enabled =
      dbCapabilities[manifest.name as keyof CapabilitiesConfig] ??
      configEnabled;

    if (!enabled) continue;

    // Check prerequisites
    const prereqResults = manifest.prerequisites.map((p) =>
      checkPrerequisite(p),
    );
    const allReady = prereqResults.every((r) => r.ok);

    if (!allReady) {
      logger.debug(
        { plugin: manifest.name },
        'Plugin enabled but not ready (prerequisites not met)',
      );
      continue;
    }

    // Plugin is active — aggregate hooks
    const { container } = manifest;

    // Mounts (deduplicate by containerPath)
    for (const mount of container.mounts) {
      // Check condition
      if (mount.condition) {
        const match = mount.condition.match(/^prerequisite:(\d+)$/);
        if (match) {
          const idx = parseInt(match[1], 10);
          if (!prereqResults[idx]?.ok) continue;
        }
      }

      if (!mountedPaths.has(mount.containerPath)) {
        hooks.mounts.push(mount);
        mountedPaths.add(mount.containerPath);
      }
    }

    // Env vars
    Object.assign(hooks.envVars, container.envVars);

    // Entrypoint commands
    hooks.entrypointCommands.push(...container.entrypointCommands);

    // MCP servers
    Object.assign(hooks.mcpServers, container.mcpServers);

    // Allowed tools
    hooks.allowedTools.push(...container.allowedTools);

    // Skills
    hooks.skills.push(...container.skills);

    // Host behavior
    if (manifest.hostBehavior?.worktrees) {
      hooks.worktreesEnabled = true;
    }
  }

  return hooks;
}

/** Reset caches (for testing). */
export function _resetPluginCaches(): void {
  cachedManifests = null;
  cachedCapabilities = null;
}
