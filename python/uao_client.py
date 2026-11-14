"""Zero-dependency Python 3.9+ client for Universal Agent Optimizer HTTP Proxy."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional


class UaoProxyClient:
    """Lightweight client that routes OpenAI or Anthropic payloads via `uao proxy`."""

    def __init__(
        self,
        proxy_url: str = "http://127.0.0.1:8787",
        *,
        session_id: str = "python-default",
        agent_id: str = "python-agent",
        scene: str = "default",
        api_key: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        self.proxy_url = proxy_url.rstrip("/")
        self.session_id = session_id
        self.agent_id = agent_id
        self.scene = scene
        self.api_key = api_key
        self.timeout = timeout

    def _build_headers(
        self,
        *,
        session_id: Optional[str] = None,
        scene: Optional[str] = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "content-type": "application/json",
            "x-session-id": session_id or self.session_id,
            "x-conversation-key": session_id or self.session_id,
            "x-agent-id": self.agent_id,
            "x-agent-scene": scene or self.scene,
        }
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
            headers["x-api-key"] = self.api_key
        if extra_headers:
            headers.update(extra_headers)
        return headers

    def _request_json(
        self,
        method: str,
        path: str,
        payload: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(
            f"{self.proxy_url}{path}",
            data=body,
            headers=headers or {},
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                data = json.loads(raw) if raw else {}
                return {
                    "status": resp.status,
                    "headers": {k.lower(): v for k, v in resp.headers.items()},
                    "data": data,
                }
        except urllib.error.HTTPError as exc:
            err_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"UAO proxy HTTP {exc.code} on {path}: {err_body}") from exc

    def health(self) -> Dict[str, Any]:
        return self._request_json("GET", "/health")["data"]

    def metrics(self) -> Dict[str, Any]:
        return self._request_json("GET", "/metrics")["data"]

    def chat_completions(
        self,
        *,
        model: str,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        session_id: Optional[str] = None,
        scene: Optional[str] = None,
        **extra_payload: Any,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            **extra_payload,
        }
        if tools is not None:
            payload["tools"] = tools
        return self._request_json(
            "POST",
            "/v1/chat/completions",
            payload=payload,
            headers=self._build_headers(session_id=session_id, scene=scene),
        )

    def messages(
        self,
        *,
        model: str,
        messages: List[Dict[str, Any]],
        system: Optional[str] = None,
        max_tokens: int = 1024,
        tools: Optional[List[Dict[str, Any]]] = None,
        session_id: Optional[str] = None,
        scene: Optional[str] = None,
        anthropic_version: str = "2023-06-01",
        **extra_payload: Any,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            **extra_payload,
        }
        if system is not None:
            payload["system"] = system
        if tools is not None:
            payload["tools"] = tools
        return self._request_json(
            "POST",
            "/v1/messages",
            payload=payload,
            headers=self._build_headers(
                session_id=session_id,
                scene=scene,
                extra_headers={"anthropic-version": anthropic_version},
            ),
        )
