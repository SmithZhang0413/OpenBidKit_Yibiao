const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const server = new Server(
  { name: 'yibiao-fake-visio-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: '返回传入文本',
      inputSchema: {
        type: 'object',
        required: ['text'],
        additionalProperties: false,
        properties: { text: { type: 'string' } },
      },
    },
    {
      name: 'delay',
      description: '等待指定毫秒数',
      inputSchema: {
        type: 'object',
        properties: { milliseconds: { type: 'number' } },
      },
    },
    {
      name: 'fail',
      description: '返回工具错误',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'soft_fail',
      description: '以普通 JSON 返回工具错误',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name === 'echo') {
    return { content: [{ type: 'text', text: String(args.text || '') }] };
  }
  if (name === 'delay') {
    const milliseconds = Math.max(0, Number(args.milliseconds) || 0);
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return { content: [{ type: 'text', text: `waited:${milliseconds}` }] };
  }
  if (name === 'fail') {
    return { isError: true, content: [{ type: 'text', text: '模拟 Visio 工具失败' }] };
  }
  if (name === 'soft_fail') {
    return { content: [{ type: 'text', text: JSON.stringify({ error: '模拟软错误' }) }] };
  }
  return { isError: true, content: [{ type: 'text', text: `未知工具：${name}` }] };
});

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
