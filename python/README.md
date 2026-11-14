[English](README.md) | [简体中文](README.zh-CN.md)

# Python Integration Guide (via UAO Local HTTP Proxy)

Universal Agent Optimizer provides zero-dependency local HTTP proxy integration for Python agents (`OpenAI SDK`, `Anthropic SDK`, `LangGraph`, `AutoGen`, or `uao_client.py`).

## 1. Start the Local Proxy

```bash
npx uao proxy --upstream https://api.openai.com --port 8787 --provider openai
```

## 2. Option A: Use Zero-Dependency `UaoProxyClient`

```python
from python.uao_client import UaoProxyClient

client = UaoProxyClient(
    proxy_url="http://127.0.0.1:8787",
    session_id="coding-session-1",
    scene="coding",
    api_key="YOUR_API_KEY",
)

print(client.health())

res = client.chat_completions(
    model="gpt-4o-mini",
    messages=[
        {"role": "system", "content": "Be concise."},
        {"role": "user", "content": "Summarize cache prefix stability."},
    ],
)
print(res["headers"].get("x-uao-cache-intact"), res["data"])
print(client.metrics())
```

## 3. Option B: Point Official OpenAI / LangGraph / Anthropic Python SDKs to `http://127.0.0.1:8787`

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="YOUR_API_KEY",
    default_headers={
        "x-session-id": "langgraph-run-42",
        "x-agent-scene": "coding",
    },
)
```
