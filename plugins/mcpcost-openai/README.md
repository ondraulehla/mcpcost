# mcpcost as a ChatGPT plugin

The package for the plugin directory of OpenAI (https://platform.openai.com/plugins): one remote MCP server,
`https://mcpcost.ulehla.dev/mcp`, with no authentication, no skills and no UI. The fields follow
https://developers.openai.com/plugins/deploy/submission as read on 2026-11-13. The portal checks the package at
upload and reports errors; correct them here and upload again.

Before the upload:

1. Record a short video that shows the five positive test cases of `plugin.json` in ChatGPT, put it at a URL that
   a reviewer can open, and write that URL into `review.demo_recording_url`.
2. Make the ZIP from inside this folder, so that `plugin.json` is at the root of the archive:

   ```sh
   cd plugins/mcpcost-openai && zip -r ../../mcpcost-openai-plugin.zip plugin.json mcp.json assets
   ```

After the upload, the portal's "Connect MCP server" drawer shows a domain verification token. The site serves it at
`https://mcpcost.ulehla.dev/.well-known/openai-apps-challenge` from the Worker secret `OPENAI_APPS_CHALLENGE`:

```sh
cd site && npx wrangler secret put OPENAI_APPS_CHALLENGE
```

The version in `plugin.json` is the version of the npm package. `assets/logo.png` is `site/public/icon-512.png`.
