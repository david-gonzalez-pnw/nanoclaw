/**
 * Azure Application Insights MCP Server for NanoClaw
 * Provides tools for querying App Insights telemetry from the container agent.
 * Authenticates via service principal credentials at AZURE_SP_PATH.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ClientSecretCredential } from '@azure/identity';
import { LogsQueryClient, LogsQueryResultStatus, MetricsQueryClient } from '@azure/monitor-query';
import type { LogsTable } from '@azure/monitor-query';
import fs from 'fs';
import { z } from 'zod';

interface ServicePrincipal {
  appId: string;
  password: string;
  tenant: string;
  subscriptionId?: string;
  appInsightsId?: string; // App Insights resource workspace ID (for logs queries)
}

const spPath = process.env.AZURE_SP_PATH || '/secrets/azure-sp.json';
const sp: ServicePrincipal = JSON.parse(fs.readFileSync(spPath, 'utf-8'));

const credential = new ClientSecretCredential(sp.tenant, sp.appId, sp.password);
const logsClient = new LogsQueryClient(credential);
const metricsClient = new MetricsQueryClient(credential);

const server = new McpServer({
  name: 'app_insights',
  version: '1.0.0',
});

function parseTimeRange(range: string): { start: Date; end: Date } {
  const match = range.match(/^(\d+)\s*(m|h|d)$/i);
  if (!match) {
    return { start: new Date(Date.now() - 60 * 60 * 1000), end: new Date() };
  }
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const ms = unit === 'm' ? value * 60 * 1000
    : unit === 'h' ? value * 60 * 60 * 1000
    : value * 24 * 60 * 60 * 1000;
  return { start: new Date(Date.now() - ms), end: new Date() };
}

function formatTable(columns: string[], rows: unknown[][]): string {
  if (rows.length === 0) return 'No results.';
  const header = columns.join(' | ');
  const separator = columns.map(() => '---').join(' | ');
  const body = rows.map(row =>
    row.map(cell => cell === null || cell === undefined ? '' : String(cell)).join(' | '),
  ).join('\n');
  return `${header}\n${separator}\n${body}`;
}

// --- Tool: query_logs ---

server.tool(
  'query_logs',
  'Run a KQL query against Application Insights logs. Query tables like traces, exceptions, requests, dependencies, customEvents, pageViews, etc.',
  {
    workspace_id: z.string().describe(
      'Application Insights workspace ID (the GUID from the API Access blade, or set appInsightsId in azure-sp.json)',
    ).optional(),
    query: z.string().describe(
      'KQL query to execute, e.g. "exceptions | where timestamp > ago(1h) | project timestamp, type, outerMessage | take 20"',
    ),
    time_range: z.string().optional().describe(
      'Time range for the query, e.g. "1h", "30m", "7d". Defaults to "1h". Applied as the query timespan, not as a filter in KQL.',
    ),
  },
  async (args) => {
    try {
      const workspaceId = args.workspace_id || sp.appInsightsId;
      if (!workspaceId) {
        return {
          content: [{ type: 'text' as const, text: 'Error: No workspace_id provided and appInsightsId not set in azure-sp.json. Provide the Application Insights workspace ID (GUID from API Access blade).' }],
          isError: true,
        };
      }

      const { start, end } = parseTimeRange(args.time_range || '1h');
      const result = await logsClient.queryWorkspace(workspaceId, args.query, {
        startTime: start,
        endTime: end,
      });

      if (result.status === LogsQueryResultStatus.PartialFailure) {
        return {
          content: [{ type: 'text' as const, text: `Query partial failure: ${JSON.stringify(result.partialError, null, 2)}` }],
          isError: true,
        };
      }

      const tables: LogsTable[] = result.tables;
      if (tables.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Query returned no tables.' }] };
      }

      const parts: string[] = [];
      for (const table of tables) {
        const columns = table.columnDescriptors.map(c => c.name || '?');
        const rows = table.rows as unknown[][];
        parts.push(formatTable(columns, rows));
      }

      return {
        content: [{ type: 'text' as const, text: `Query: ${args.query}\nResults (${tables[0].rows.length} rows):\n\n${parts.join('\n\n')}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error querying logs: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Tool: list_exceptions ---

server.tool(
  'list_exceptions',
  'List recent exceptions from Application Insights with stack traces. Shortcut for common exception queries.',
  {
    workspace_id: z.string().optional().describe('Application Insights workspace ID'),
    time_range: z.string().optional().describe('Time range, e.g. "1h", "24h", "7d". Defaults to "24h".'),
    limit: z.number().optional().describe('Max exceptions to return (1-100). Defaults to 20.'),
  },
  async (args) => {
    try {
      const workspaceId = args.workspace_id || sp.appInsightsId;
      if (!workspaceId) {
        return {
          content: [{ type: 'text' as const, text: 'Error: No workspace_id provided and appInsightsId not set in azure-sp.json.' }],
          isError: true,
        };
      }

      const limit = Math.min(Math.max(args.limit || 20, 1), 100);
      const { start, end } = parseTimeRange(args.time_range || '24h');

      const query = `exceptions
| project timestamp, type, outerMessage, innermostMessage, details
| order by timestamp desc
| take ${limit}`;

      const result = await logsClient.queryWorkspace(workspaceId, query, {
        startTime: start,
        endTime: end,
      });

      if (result.status === LogsQueryResultStatus.PartialFailure) {
        return {
          content: [{ type: 'text' as const, text: `Query partial failure: ${JSON.stringify(result.partialError, null, 2)}` }],
          isError: true,
        };
      }

      const tables: LogsTable[] = result.tables;
      const table = tables[0];
      if (!table || table.rows.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No exceptions found in the specified time range.' }] };
      }

      const columns = table.columnDescriptors.map(c => c.name || '?');
      const formatted = formatTable(columns, table.rows as unknown[][]);

      return {
        content: [{ type: 'text' as const, text: `Recent exceptions (${table.rows.length}):\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error listing exceptions: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Tool: query_metrics ---

server.tool(
  'query_metrics',
  'Query Application Insights metrics like response time, failure rate, request count, dependency duration, etc.',
  {
    resource_id: z.string().describe(
      'Full Azure resource ID for the App Insights resource, e.g. /subscriptions/{sub}/resourceGroups/{rg}/providers/microsoft.insights/components/{name}',
    ),
    metric_names: z.array(z.string()).describe(
      'Metric names to query, e.g. ["requests/count", "requests/failed", "requests/duration", "exceptions/count", "dependencies/duration"]',
    ),
    time_range: z.string().optional().describe('Time range, e.g. "1h", "24h", "7d". Defaults to "24h".'),
    interval: z.string().optional().describe('Aggregation interval in ISO 8601 duration, e.g. "PT1H", "PT5M". Defaults to "PT1H".'),
  },
  async (args) => {
    try {
      const { start, end } = parseTimeRange(args.time_range || '24h');

      const results: string[] = [];
      for (const metricName of args.metric_names) {
        const response = await metricsClient.queryResource(
          args.resource_id,
          [metricName],
          {
            timespan: { startTime: start, endTime: end },
            granularity: args.interval || 'PT1H',
          },
        );

        for (const metric of response.metrics) {
          results.push(`## ${metric.name}`);
          for (const ts of metric.timeseries) {
            for (const dp of ts.data || []) {
              const time = dp.timeStamp.toISOString();
              const values = [
                dp.average !== undefined ? `avg=${dp.average}` : null,
                dp.count !== undefined ? `count=${dp.count}` : null,
                dp.total !== undefined ? `total=${dp.total}` : null,
                dp.minimum !== undefined ? `min=${dp.minimum}` : null,
                dp.maximum !== undefined ? `max=${dp.maximum}` : null,
              ].filter(Boolean).join(', ');
              results.push(`  ${time}: ${values}`);
            }
          }
        }
      }

      return {
        content: [{ type: 'text' as const, text: results.length > 0 ? results.join('\n') : 'No metric data found.' }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error querying metrics: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
