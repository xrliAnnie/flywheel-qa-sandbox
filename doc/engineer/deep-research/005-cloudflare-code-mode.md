---
source: "https://blog.cloudflare.com/code-mode/"
date: 2026-02-26
topic: "Cloudflare Code Mode — MCP as TypeScript API, not Tool Calls"
relevance: "Medium — MCP tool efficiency pattern, V8 isolate sandboxing. Not directly applicable to current plan but useful for Phase 2+ (multi-tool agents, cloud execution)."
---

# Cloudflare Code Mode: The Better Way to Use MCP

## Core Thesis

**LLMs are better at writing code to call MCP, than at calling MCP directly.**

Two primary advantages:

1. **Scale and Complexity**: Agents handle significantly more tools and complex tool interactions when presented as TypeScript APIs rather than direct tool calls.
2. **Chaining Efficiency**: When agents string together multiple operations, code-based approaches eliminate the inefficiency of feeding intermediate results through the LLM's neural network repeatedly. The LLM can "skip all that, and only read back the final results it needs."

LLMs have seen a lot of code in training; they have not seen a lot of "tool calls" (synthetic tokens). Making an LLM use tool calling is like "putting Shakespeare through a month-long class in Mandarin and then asking him to write a play in it."

## Architecture: MCP to TypeScript Conversion

When Code Mode connects to an MCP server, the Agents SDK:
- Fetches the MCP server's schema
- Converts it into TypeScript interfaces with documentation comments
- Loads the TypeScript API into the agent's context

The agent receives a single tool: **code execution capability**. Instead of calling MCP tools directly, it writes TypeScript code that calls the generated API.

## Execution Flow

1. Agent generates TypeScript code
2. Code runs in a secure, isolated sandbox (V8 isolate)
3. Sandbox has zero Internet access
4. Only contact with external systems occurs through TypeScript APIs representing MCP servers
5. RPC invocations route calls back to the agent loop
6. The Agents SDK dispatches to appropriate MCP servers
7. Results return via `console.log()` output

## V8 Isolates Over Containers

Cloudflare uses Workers' V8 isolate-based architecture:
- Isolates start in "a handful of milliseconds using only a few megabytes of memory"
- No need to reuse or prewarm — create, run, throw away
- Isolation at runtime level, not OS level
- Worker Loader API for dynamic isolate creation

## Security Architecture

Three layers:
1. **Network Isolation**: Global `fetch()` and `connect()` throw errors in sandboxed workers
2. **Binding-Based Access**: MCP servers exposed as JavaScript bindings, not network endpoints
3. **Credential Hiding**: Bindings provide pre-authorized client interfaces, preventing API key leakage

## Scale Impact

Cloudflare's 2,500+ API endpoints would consume **over 2 million tokens** as individual MCP tools. Code Mode collapsed it into **2 tools and ~1,000 tokens of context**.

## Flywheel Takeaways

1. **Future MCP strategy**: If we expose many tools (Linear, GitHub, Slack, docs) to agents, convert to TypeScript APIs instead of raw MCP tool definitions — massive token savings
2. **V8 isolate sandboxing**: Lightweight alternative to Docker for agent execution isolation (Phase 2+ when moving to VPS/cloud)
3. **Single-tool pattern**: Giving agent one powerful tool (code execution) is more effective than many narrow tools — consider for Phase 3+ when agent capabilities expand
4. **Not immediately actionable**: Current plan uses Agent SDK `query()` which manages tool calling internally; Code Mode is relevant when we need custom tool orchestration
