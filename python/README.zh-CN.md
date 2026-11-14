[English](README.md) | [简体中文](README.zh-CN.md)

# Python 接入指南（基于 UAO 本地 HTTP 代理）

Universal Agent Optimizer 为 Python Agent（`OpenAI SDK`、`Anthropic SDK`、`LangGraph`、`AutoGen` 或零依赖 `uao_client.py`）提供零第三方依赖的本地透明 HTTP 代理接入方案。

## 1. 启动本地代理

```bash
npx uao proxy --upstream https://api.openai.com --port 8787 --provider openai
```

## 2. 方案 A：使用零依赖 `UaoProxyClient`

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

## 3. 方案 B：将官方 OpenAI / LangGraph / Anthropic Python SDK 的 `base_url` 指向 `http://127.0.0.1:8787`

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
