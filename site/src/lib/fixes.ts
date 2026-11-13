/**
 * The start-up errors of PyPI package servers that were written for mcp 1.x and get mcp 2.x from a plain install.
 * mcp 2.0.0 (PyPI, 2026-07-28) renamed and removed names; a package that asks for mcp with no upper bound stops at
 * the import. Each entry is one page under /errors: the exact text a person pastes into a search engine, what the
 * SDK changed, the code before and after as the SDK's migration guide shows it, and the registry servers whose
 * daily probe ends with that text. The facts were read from the guide on 2026-11-13.
 */
export const GUIDE = 'https://py.sdk.modelcontextprotocol.io/v2/migration/';

export interface Fix {
  slug: string;
  /** The error as Python prints it. The page title and the heading. */
  error: string;
  /** Other texts of the same cause, shown on the page. */
  alsoSeenAs?: string[];
  /** SQL LIKE patterns over servers.error; a server with any of them has this error. */
  like: string[];
  /** The same test over one error text, for the server page. */
  test: RegExp;
  /** One sentence: what mcp 2.x changed. */
  changed: string;
  before: string;
  after: string;
  /** More that the guide says about this change. */
  notes: string[];
  /** The section of the migration guide. */
  guide: string;
  /** True when the daily probe installs the package once more with mcp<2 (probe/stdio-classify.ts). */
  retried?: boolean;
}

export const FIXES: Fix[] = [
  {
    slug: 'no-module-named-mcp-server-fastmcp',
    error: "ModuleNotFoundError: No module named 'mcp.server.fastmcp'",
    like: ["%No module named %mcp.server.fastmcp%"],
    test: /No module named '?mcp\.server\.fastmcp/,
    changed: 'mcp 2.0 renamed FastMCP to MCPServer and moved it from mcp.server.fastmcp to mcp.server.mcpserver. An import of mcp.server.fastmcp, or of a name below it, stops with ModuleNotFoundError.',
    before: 'from mcp.server.fastmcp import FastMCP\n\nmcp = FastMCP("Demo")',
    after: 'from mcp.server.mcpserver import MCPServer\n\nmcp = MCPServer("Demo")',
    notes: [
      'FastMCPError is now MCPServerError, and ctx.fastmcp is now ctx.mcp_server.',
      'The decorators @mcp.tool(), @mcp.resource() and @mcp.prompt() take the same arguments as before.',
      'Transport arguments such as port and json_response moved from the constructor to run() and the app methods.',
      'Give the name as the first argument and all other constructor arguments by keyword: the order of the positional parameters changed.'
    ],
    guide: `${GUIDE}#fastmcp-renamed-to-mcpserver`,
    retried: true
  },
  {
    slug: 'server-object-has-no-attribute-list-tools',
    error: "AttributeError: 'Server' object has no attribute 'list_tools'",
    alsoSeenAs: ["AttributeError: 'Server' object has no attribute 'call_tool'", "AttributeError: 'Server' object has no attribute 'list_prompts'", "AttributeError: 'Server' object has no attribute 'list_resources'"],
    like: ["%'Server' object has no attribute 'list_%", "%'Server' object has no attribute 'call_tool%", "%'Server' object has no attribute 'get_prompt%", "%'Server' object has no attribute 'read_resource%"],
    test: /'Server' object has no attribute '(list_|call_tool|get_prompt|read_resource)/,
    changed: 'In mcp 2.0 the lowlevel Server class has no decorator methods. You give each handler to the constructor as an on_* argument.',
    before: '@server.list_tools()\nasync def handle_list_tools():\n    return [types.Tool(name="my_tool", description="A tool", inputSchema={})]',
    after: 'async def handle_list_tools(ctx: ServerRequestContext, params: PaginatedRequestParams | None) -> ListToolsResult:\n    return ListToolsResult(tools=[Tool(name="my_tool", description="A tool", input_schema={"type": "object"})])\n\nserver = Server("my-server", on_list_tools=handle_list_tools, on_call_tool=handle_call_tool)',
    notes: [
      'Each decorator has an argument of the same name with on_ in front: list_tools is on_list_tools, call_tool is on_call_tool, list_resources is on_list_resources, read_resource is on_read_resource, list_prompts is on_list_prompts, get_prompt is on_get_prompt.',
      'A handler gets (ctx, params) and returns the full result type, for example ListToolsResult.',
      'The Server does not check the arguments of a tool call against the input schema any more. Do that in your handler.',
      'The guide has the imports and the call_tool handler that this example leaves out.'
    ],
    guide: `${GUIDE}#lowlevel-server-decorator-based-handlers-replaced-with-constructor-on_-params`
  },
  {
    slug: 'cannot-import-name-fastmcp-from-mcp-server',
    error: "ImportError: cannot import name 'FastMCP' from 'mcp.server'",
    like: ["%cannot import name 'FastMCP' from 'mcp.server'%"],
    test: /cannot import name 'FastMCP' from 'mcp\.server'/,
    changed: 'mcp 2.0 renamed FastMCP to MCPServer, so mcp.server has no name FastMCP. It is the same change that stops an import of mcp.server.fastmcp.',
    before: 'from mcp.server import FastMCP\n\nmcp = FastMCP("Demo")',
    after: 'from mcp.server.mcpserver import MCPServer\n\nmcp = MCPServer("Demo")',
    notes: [
      'The migration guide names the module error (No module named mcp.server.fastmcp). This text is the same rename, seen from an import of the name out of mcp.server.',
      'FastMCPError is now MCPServerError, and ctx.fastmcp is now ctx.mcp_server.',
      'Transport arguments such as port and json_response moved from the constructor to run() and the app methods.'
    ],
    guide: `${GUIDE}#fastmcp-renamed-to-mcpserver`
  },
  {
    slug: 'cannot-import-name-streamablehttp-client',
    error: "ImportError: cannot import name 'streamablehttp_client' from 'mcp.client.streamable_http'",
    like: ["%cannot import name 'streamablehttp_client'%"],
    test: /cannot import name 'streamablehttp_client'/,
    changed: 'mcp 2.0 removed the function streamablehttp_client, which mcp 1.x had marked as deprecated. The function to use is streamable_http_client, with an underscore after streamable.',
    before: 'from mcp.client.streamable_http import streamablehttp_client',
    after: 'import httpx2\nfrom mcp.client.streamable_http import streamable_http_client\n\nhttp_client = httpx2.AsyncClient(headers={...}, timeout=httpx2.Timeout(30, read=300), auth=my_auth)\nasync with http_client:\n    async with streamable_http_client(\n        url="http://localhost:8000/mcp",\n        http_client=http_client,\n    ) as (read_stream, write_stream):\n        ...',
    notes: [
      'The new function gives two values, (read_stream, write_stream). The old one gave three.',
      'Headers, the timeout and auth go on an httpx2.AsyncClient that you give as http_client.',
      'mcp 2.x uses httpx2 and does not install httpx. Code that imports httpx and relied on mcp to install it stops with ModuleNotFoundError: No module named \'httpx\'.',
      'An import of GetSessionIdCallback also stops with ImportError.'
    ],
    guide: `${GUIDE}#streamablehttp_client-removed`
  },
  {
    slug: 'cannot-import-name-mcperror',
    error: "ImportError: cannot import name 'McpError' from 'mcp.shared.exceptions'",
    alsoSeenAs: ["ImportError: cannot import name 'McpError' from 'mcp'"],
    like: ["%cannot import name 'McpError'%"],
    test: /cannot import name 'McpError'/,
    changed: 'mcp 2.0 renamed the exception class McpError to MCPError.',
    before: 'from mcp.shared.exceptions import McpError\n\nraise McpError(ErrorData(code=INVALID_REQUEST, message="bad input"))',
    after: 'from mcp.shared.exceptions import MCPError\n\nraise MCPError(INVALID_REQUEST, "bad input")',
    notes: [
      'from mcp import MCPError works too.',
      'Read the text of a caught error from e.message. In mcp 1.x it was e.error.message.'
    ],
    guide: `${GUIDE}#mcperror-renamed-to-mcperror`
  }
];

/** The fix page for a server's error text, if the text is one of the known mcp 2.x errors. */
export function fixFor(error: string | null | undefined): Fix | undefined {
  if (!error) return undefined;
  return FIXES.find((f) => f.test.test(error));
}

/** The PyPI package of a server URL of the form pypi:<name>==<version>, without the version. */
export function pypiPackage(url: string): string | null {
  if (!url.startsWith('pypi:')) return null;
  return url.slice(5).split(/==|@/)[0] || null;
}
