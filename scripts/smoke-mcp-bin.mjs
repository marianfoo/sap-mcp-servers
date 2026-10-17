#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const [packagePath, binName, expectedServerName] = process.argv.slice(2);

if (!packagePath || !binName || !expectedServerName) {
  console.error('Usage: node scripts/smoke-mcp-bin.mjs <package-path> <bin-name> <expected-server-name>');
  process.exit(2);
}

const packageDir = resolve(packagePath);
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const entrypoint = join(packageDir, 'dist', 'mcp-server.js');
const tempDir = mkdtempSync(join(tmpdir(), `${binName}-`));
const binPath = join(tempDir, binName);
let server;

function cleanup() {
  if (server && server.exitCode === null && !server.killed) {
    server.kill('SIGTERM');
  }
  rmSync(tempDir, { recursive: true, force: true });
}

try {
  symlinkSync(entrypoint, binPath);

  server = spawn(process.execPath, [binPath], {
    cwd: packageDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MCP_MODE: 'true',
      MCP_TRANSPORT: 'stdio',
      LOG_LEVEL: 'error'
    }
  });

  let stdout = '';
  let stderr = '';
  let stdoutBuffer = '';

  const response = await new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${binName} initialize response.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 5000);

    server.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    server.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      stdoutBuffer += text;

      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 1) {
          clearTimeout(timer);
          resolveResponse(message);
        }
      }
    });

    server.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });

    server.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`${binName} exited before initialize response with code ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });

    server.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'bin-smoke-test',
          version: '1.0.0'
        }
      }
    })}\n`);
  });

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.equal(response.result?.serverInfo?.name, expectedServerName);
  assert.equal(response.result?.serverInfo?.version, manifest.version);

  console.log(`${binName} responded to initialize through symlinked bin path.`);
} finally {
  cleanup();
}
