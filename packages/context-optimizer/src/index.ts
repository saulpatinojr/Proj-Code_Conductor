#!/usr/bin/env node
import { runMcpServer } from './mcp-server.js';

export * from './optimizer.js';
export * from './tool-output.js';
export * from './mcp-server.js';

// If executed directly as a script
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('context-optimizer/dist/index.js')) {
  runMcpServer();
}
