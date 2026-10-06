# fitness-tracker — ChatGPT/Codex plugin package

Example distribution package for the Fitness Tracker MCP server.

It carries no MCP tools of its own. The tools come from the deployed MCP server. This package adds the plugin manifest, a reference to the registered MCP connection, and two example workflow skills for logging training and reviewing progress.

Before using it:

1. Deploy your own Fitness Tracker MCP server.
2. Register its OAuth-protected `/mcp` endpoint in ChatGPT developer mode.
3. Replace the placeholder `app_id` and example server URL in `.app.json`.
4. Run `npm run validate:plugin`.

Each user should authenticate independently so the server resolves the verified Google account to that user's database binding.

This public package contains only example values and generic users.
