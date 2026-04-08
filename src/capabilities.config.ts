import { CapabilitiesConfig } from './types.js';

/**
 * Plugin capabilities for this NanoClaw instance.
 * All plugins default to disabled — enable the ones you need.
 */

const DEFAULTS: CapabilitiesConfig = {
  gcloud: false,
  gcpLogging: false,
  codeTasks: false,
  worktrees: false,
  gh: false,
  azure: false,
  appInsights: false,
};

const capabilities: CapabilitiesConfig = {
  ...DEFAULTS,
  gcloud: true,
  gcpLogging: true,
  codeTasks: true,
  worktrees: true,
  gh: true,
  azure: true,
  appInsights: true,
};

export default capabilities;
