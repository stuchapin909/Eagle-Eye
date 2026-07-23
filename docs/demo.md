# Open Eagle Eye — 60-second demo

## 1. Configure MCP

### Claude Desktop
Add to your MCP config (path varies by OS):

```json
{
  "mcpServers": {
    "openeagleeye": {
      "command": "npx",
      "args": ["-y", "openeagleeye"]
    }
  }
}
```

See also `examples/claude_desktop_config.snippet.json`.

### Cursor
See `examples/cursor_mcp.snippet.json`.

First start downloads the camera registry (checksum-verified) into `~/.openeagleeye/`.

## 2. Try these prompts

**Traffic:** "What's traffic like near the Brooklyn Bridge right now? Use Open Eagle Eye."

**Weather / snow:** "Is it snowing at any ski-resort cameras in Colorado? Snapshot one and describe it."

**Explore:** "Show me three random nature or beach cameras and describe what you see."

## 3. Expected tool sequence

1. `search_cameras` or `nearby_cameras` (if you have lat/lng)
2. `get_snapshot` or `get_snapshots`
3. Vision on the saved file path
4. Short natural-language answer

## 4. Optional prompts

MCP prompts: `traffic-check`, `weather-check`, `discover-cameras`.

## 5. Troubleshooting

- Empty registry: delete `~/.openeagleeye/cameras.json` and restart (re-fetch + sha256 verify).
- API key cameras: `check_config` and `~/.openeagleeye/config.json`.
- Plain HTTP blocked: set `"allow_insecure_http": true` in config (default is true).
