#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerApiTesterTools } from './tools/api-tester.js';
import { registerCodeAuditorTools } from './tools/code-auditor.js';
import { registerDbBridgeTools } from './tools/db-bridge.js';
import { registerPatcherTools } from './tools/patcher.js';
import { registerReporterTools } from './tools/reporter.js';
import { registerTestRunnerTools } from './tools/test-runner.js';
import { closeAllConnections } from './utils/db-connection.js';
import { BACKEND_ROOT } from './utils/paths.js';

// stdout está reservado para JSON-RPC: cualquier console.log accidental (propio o de dependencias) se desvía a stderr.
console.log = (...args: unknown[]): void => console.error(...args);
console.info = (...args: unknown[]): void => console.error(...args);
console.debug = (...args: unknown[]): void => console.error(...args);

async function main(): Promise<void> {
  const server = new McpServer(
    { name: 'backend-qa-server', version: '1.0.0' },
    {
      instructions:
        'Servidor de QA para el backend NestJS ubicado en el directorio padre. Flujo recomendado: ' +
        'run_backend_tests + run_backend_linter_and_typecheck + inspect_db_schema_and_models para la foto inicial; ' +
        'read_backend_file / audit_error_handling / inspect_env_variables para diagnosticar; http_request_endpoint contra la API viva; ' +
        'apply_backend_fix → volver a ejecutar pruebas → revert_backend_file si fallan; generate_backend_bug_report al final.',
    },
  );

  registerTestRunnerTools(server);
  registerApiTesterTools(server);
  registerCodeAuditorTools(server);
  registerDbBridgeTools(server);
  registerPatcherTools(server);
  registerReporterTools(server);

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[backend-qa] ${signal} recibido, cerrando…`);
    await closeAllConnections();
    await server.close().catch((error: unknown) => console.error('[backend-qa] Error cerrando servidor:', error));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => console.error('[backend-qa] unhandledRejection:', reason));
  process.on('uncaughtException', (error) => console.error('[backend-qa] uncaughtException:', error));

  await server.connect(new StdioServerTransport());
  console.error(`[backend-qa] Servidor MCP listo (stdio). Backend inspeccionado: ${BACKEND_ROOT}`);
}

main().catch((error: unknown) => {
  console.error('[backend-qa] Error fatal al iniciar:', error);
  process.exit(1);
});
