/**
 * GCP Cloud Logging MCP Server for NanoClaw
 * Provides tools for querying Google Cloud Logging from the container agent.
 * Credentials auto-discovered via GOOGLE_APPLICATION_CREDENTIALS env var.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Logging, Entry } from '@google-cloud/logging';
import { z } from 'zod';

const DEFAULT_RESOURCE_TYPES = ['cloud_function', 'cloud_run_revision'];

// SDK auto-discovers project ID and credentials from GOOGLE_APPLICATION_CREDENTIALS
const logging = new Logging();

const server = new McpServer({
  name: 'gcp_logging',
  version: '1.0.0',
});

/**
 * Parse a human-friendly time range like "1h", "30m", "7d" into a Date.
 */
function parseTimeRange(range: string): Date {
  const match = range.match(/^(\d+)\s*(m|h|d)$/i);
  if (!match) {
    // Default to 1 hour if unparseable
    return new Date(Date.now() - 60 * 60 * 1000);
  }
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const ms = unit === 'm' ? value * 60 * 1000
    : unit === 'h' ? value * 60 * 60 * 1000
    : value * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms);
}

/**
 * Format a log entry into a compact readable summary.
 */
function formatEntry(entry: Entry): string {
  const meta = entry.metadata;
  const ts = meta.timestamp
    ? new Date(meta.timestamp as string).toISOString()
    : 'unknown';
  const severity = meta.severity || 'DEFAULT';
  const resourceType = meta.resource?.type || 'unknown';
  const resourceLabels = meta.resource?.labels
    ? Object.entries(meta.resource.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
    : '';
  const insertId = meta.insertId || '';

  // Extract the payload text
  let payload = '';
  if (entry.data && typeof entry.data === 'string') {
    payload = entry.data;
  } else if (entry.data && typeof entry.data === 'object') {
    const d = entry.data as Record<string, unknown>;
    payload = d.message as string || d.textPayload as string || JSON.stringify(d);
  }

  // Truncate payload for summary view
  const maxLen = 500;
  const truncated = payload.length > maxLen
    ? payload.slice(0, maxLen) + '...'
    : payload;

  return [
    `[${ts}] ${severity} | ${resourceType} (${resourceLabels})`,
    `  insertId: ${insertId}`,
    `  ${truncated}`,
  ].join('\n');
}

// --- Tool: query_logs ---

server.tool(
  'query_logs',
  'Query Google Cloud Logging entries. Filter by resource type, severity, text search, and time range. Returns recent log entries matching the criteria.',
  {
    resource_type: z.string().optional().describe(
      'GCP resource type to filter (e.g. "cloud_function", "cloud_run_revision"). Defaults to cloud_function + cloud_run_revision. Use list_resource_types to discover available types.',
    ),
    severity: z.enum([
      'DEFAULT', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY',
    ]).optional().describe('Minimum log severity to filter'),
    text_filter: z.string().optional().describe(
      'Free-text search in log payload (searches textPayload and jsonPayload.message)',
    ),
    time_range: z.string().optional().describe(
      'Time range to search, e.g. "1h", "30m", "7d". Defaults to "1h".',
    ),
    limit: z.number().optional().describe(
      'Max entries to return (1-500). Defaults to 50.',
    ),
    custom_filter: z.string().optional().describe(
      'Raw Cloud Logging filter string (advanced). When set, overrides resource_type, severity, and text_filter.',
    ),
  },
  async (args) => {
    try {
      const since = parseTimeRange(args.time_range || '1h');
      const pageSize = Math.min(Math.max(args.limit || 50, 1), 500);

      let filter: string;

      if (args.custom_filter) {
        filter = `${args.custom_filter} AND timestamp >= "${since.toISOString()}"`;
      } else {
        const parts: string[] = [`timestamp >= "${since.toISOString()}"`];

        // Resource type filter
        if (args.resource_type) {
          parts.push(`resource.type = "${args.resource_type}"`);
        } else {
          const types = DEFAULT_RESOURCE_TYPES
            .map(t => `resource.type = "${t}"`)
            .join(' OR ');
          parts.push(`(${types})`);
        }

        // Severity filter
        if (args.severity) {
          parts.push(`severity >= ${args.severity}`);
        }

        // Text search
        if (args.text_filter) {
          const escaped = args.text_filter.replace(/"/g, '\\"');
          parts.push(`(textPayload =~ "${escaped}" OR jsonPayload.message =~ "${escaped}")`);
        }

        filter = parts.join(' AND ');
      }

      const [entries] = await logging.getEntries({
        filter,
        pageSize,
        orderBy: 'timestamp desc',
      });

      if (entries.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No log entries found matching filter:\n${filter}` }],
        };
      }

      const formatted = entries.map(formatEntry).join('\n\n---\n\n');
      const header = `Found ${entries.length} log entries (filter: ${filter}):\n\n`;

      return {
        content: [{ type: 'text' as const, text: header + formatted }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error querying logs: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Tool: get_log_entry ---

server.tool(
  'get_log_entry',
  'Get the full details of a specific log entry by its insertId. Use this after query_logs to get complete stack traces and metadata.',
  {
    insert_id: z.string().describe('The insertId of the log entry to retrieve'),
    resource_type: z.string().optional().describe('Resource type to narrow the search (optional)'),
  },
  async (args) => {
    try {
      let filter = `insertId = "${args.insert_id}"`;
      if (args.resource_type) {
        filter += ` AND resource.type = "${args.resource_type}"`;
      }

      const [entries] = await logging.getEntries({
        filter,
        pageSize: 1,
      });

      if (entries.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No log entry found with insertId: ${args.insert_id}` }],
        };
      }

      const entry = entries[0];
      const full = JSON.stringify(
        {
          metadata: entry.metadata,
          data: entry.data,
        },
        null,
        2,
      );

      return {
        content: [{ type: 'text' as const, text: full }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error retrieving log entry: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Tool: list_resource_types ---

server.tool(
  'list_resource_types',
  'List GCP resource types that have recent log entries. Useful for discovering what resource types are available to query.',
  {},
  async () => {
    try {
      const since = new Date(Date.now() - 60 * 60 * 1000); // Last hour
      const [entries] = await logging.getEntries({
        filter: `timestamp >= "${since.toISOString()}"`,
        pageSize: 1000,
        orderBy: 'timestamp desc',
      });

      const types = new Set<string>();
      for (const entry of entries) {
        const rt = entry.metadata?.resource?.type;
        if (rt) types.add(rt);
      }

      const sorted = [...types].sort();
      if (sorted.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No resource types found with recent log entries in the last hour.' }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Resource types with recent logs (last hour):\n\n${sorted.map(t => `- ${t}`).join('\n')}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error listing resource types: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
