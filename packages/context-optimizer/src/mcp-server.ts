import * as readline from 'node:readline';
import { delimiter } from 'node:path';
import { ContextOptimizer, type OptimizationMode } from './optimizer.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// This is a deliberately small compatibility adapter, not the canonical MCP
// implementation for the project. Keep it experimental until it is migrated to
// the official MCP TypeScript SDK and validated against the then-current spec.
const MCP_PROTOCOL_VERSION = '2025-06-18';

function parseMode(value: unknown): OptimizationMode {
  if (value === undefined || value === null || value === '') return 'lossless';
  if (value === 'lossless' || value === 'aggressive') return value;
  throw new Error(`Invalid optimization mode: ${String(value)}`);
}

function requireString(args: Record<string, unknown>, name: string, allowEmpty = false): string {
  const value = args[name];
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  if (!allowEmpty && value.length === 0) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

export function runMcpServer(): void {
  const configuredRoots = process.env.CODE_CONDUCTOR_CONTEXT_ROOTS
    ?.split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const optimizer = new ContextOptimizer({ allowedRoots: configuredRoots?.length ? configuredRoots : [process.cwd()] });

  if (process.argv.includes('--stats-json')) {
    process.stdout.write(`${JSON.stringify(optimizer.getStats(), null, 2)}\n`);
    process.exit(0);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const sendResponse = (response: JsonRpcResponse): void => { process.stdout.write(`${JSON.stringify(response)}\n`); };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      sendResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const id = req.id ?? null;

    if (req.method === 'initialize') {
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'code-conductor-context-optimizer', version: '0.1.0' },
        },
      });
      return;
    }

    if (req.method === 'notifications/initialized') return;

    if (req.method === 'tools/list') {
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'compress_context',
              description: 'Prepare a context payload. Lossless mode is the default; aggressive comment/whitespace removal requires explicit opt-in.',
              inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  content: { type: 'string', description: 'Raw content to prepare. Empty content is valid.' },
                  content_type: { type: 'string', description: 'Content type or extension (for example json, yaml, tf, md).' },
                  project: { type: 'string', description: 'Telemetry label only; it does not change provider behavior.' },
                  mode: { type: 'string', enum: ['lossless', 'aggressive'], default: 'lossless' },
                },
                required: ['content'],
              },
            },
            {
              name: 'read_compressed_file',
              description: 'Read a regular file under an allowed workspace root and prepare it as context. Sensitive files, oversized files, hard links and path escapes are blocked. Available on Linux only; elsewhere, pass the content to compress_context.',
              inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  filepath: { type: 'string', description: 'Path under an allowed workspace root.' },
                  project: { type: 'string', description: 'Telemetry label only.' },
                  mode: { type: 'string', enum: ['lossless', 'aggressive'], default: 'lossless' },
                },
                required: ['filepath'],
              },
            },
            {
              name: 'retrieve_context',
              description: 'Retrieve the original payload for a context id from this process-local, time-bounded cache.',
              inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: { context_id: { type: 'string', description: 'UUID returned by compress_context.' } },
                required: ['context_id'],
              },
            },
            {
              name: 'optimization_stats',
              description: 'Return local optimization telemetry. Token counts are estimates and are not billing data.',
              inputSchema: { type: 'object', additionalProperties: false, properties: {} },
            },
          ],
        },
      });
      return;
    }

    if (req.method === 'tools/call') {
      const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      try {
        if (toolName === 'compress_context') {
          const content = requireString(args, 'content', true);
          const contentType = typeof args.content_type === 'string' ? args.content_type : 'text';
          const project = typeof args.project === 'string' ? args.project : 'vscode';
          const mode = parseMode(args.mode);
          const result = optimizer.compress(content, { contentType, project, mode });
          sendResponse({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: result.optimizedContent }],
              structuredContent: {
                contextId: result.contextId,
                mode: result.mode,
                originalTokensEstimated: result.originalTokens,
                optimizedTokensEstimated: result.optimizedTokens,
                tokensSavedEstimated: result.tokensSaved,
                tokenEstimateExact: false,
              },
            },
          });
          return;
        }

        if (toolName === 'read_compressed_file') {
          const filepath = requireString(args, 'filepath');
          const project = typeof args.project === 'string' ? args.project : 'vscode';
          const mode = parseMode(args.mode);
          const { content, result } = optimizer.readCompressedFile(filepath, project, mode);
          sendResponse({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: content }],
              structuredContent: {
                contextId: result.contextId,
                mode: result.mode,
                tokensSavedEstimated: result.tokensSaved,
                tokenEstimateExact: false,
              },
            },
          });
          return;
        }

        if (toolName === 'retrieve_context') {
          const contextId = requireString(args, 'context_id');
          const original = optimizer.retrieve(contextId);
          if (original === undefined) {
            sendResponse({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Context id not found or expired.' }], isError: true } });
            return;
          }
          sendResponse({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: original }] } });
          return;
        }

        if (toolName === 'optimization_stats') {
          sendResponse({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(optimizer.getStats(), null, 2) }] } });
          return;
        }

        sendResponse({ jsonrpc: '2.0', id, error: { code: -32601, message: `Tool not found: ${String(toolName)}` } });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        sendResponse({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${message}` }], isError: true } });
      }
      return;
    }

    sendResponse({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } });
  });
}
