#!/usr/bin/python3
"""Small, local-only Mi client for the authenticated subscription gateway.

The request is accepted on stdin so prompts never appear in process arguments.  This
program deliberately has no logging beyond category-only errors.
"""
import json
import os
import signal
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MAX_INPUT_BYTES = 24_000
MAX_PROMPT_CHARS = 18_000
MAX_RESPONSE_BYTES = 32_000
MAX_CONTENT_CHARS = 6_000
DEFAULT_TIMEOUT_SECONDS = 30
ALLOWED_MODELS = {"mi-concierge"}
EVAL_MODELS = {"mi-eval-luna-low", "mi-eval-sol-low", "mi-eval-terra-low", "mi-eval-sol-medium", "mi-eval-sol-high"}


def fail(category, code=1):
    # Categories only: never print input, HTTP bodies, paths, or token material.
    sys.stderr.write(f"mi-gateway-client: {category}\n")
    raise SystemExit(code)


def gateway_url():
    value = os.environ.get("MI_GATEWAY_URL", "http://127.0.0.1:4000/v1/chat/completions")
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"} or parsed.path != "/v1/chat/completions" or parsed.params or parsed.query or parsed.fragment:
        fail("invalid-gateway")
    if parsed.username or parsed.password or not parsed.port:
        fail("invalid-gateway")
    return value


def read_request():
    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if not data or len(data) > MAX_INPUT_BYTES:
        fail("invalid-input")
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("invalid-input")
    if not isinstance(value, dict) or set(value) - {"model", "messages", "timeoutSeconds", "outputCap", "eval"}:
        fail("invalid-input")
    model = value.get("model")
    allow_eval = value.get("eval") is True and os.environ.get("MI_GATEWAY_EVAL") == "1"
    if not isinstance(model, str) or (model not in ALLOWED_MODELS and not (allow_eval and model in EVAL_MODELS)):
        fail("invalid-model")
    messages = value.get("messages")
    if not isinstance(messages, list) or not (1 <= len(messages) <= 4):
        fail("invalid-input")
    checked = []
    total = 0
    for message in messages:
        if not isinstance(message, dict) or set(message) != {"role", "content"} or message.get("role") not in {"system", "user", "assistant"} or not isinstance(message.get("content"), str):
            fail("invalid-input")
        content = message["content"]
        if "\x00" in content or len(content) > MAX_PROMPT_CHARS:
            fail("invalid-input")
        total += len(content)
        checked.append({"role": message["role"], "content": content})
    if total > MAX_PROMPT_CHARS:
        fail("invalid-input")
    timeout = value.get("timeoutSeconds", DEFAULT_TIMEOUT_SECONDS)
    output_cap = value.get("outputCap", MAX_CONTENT_CHARS)
    if not isinstance(timeout, int) or not 1 <= timeout <= DEFAULT_TIMEOUT_SECONDS or not isinstance(output_cap, int) or not 1 <= output_cap <= MAX_CONTENT_CHARS:
        fail("invalid-input")
    return model, checked, timeout, output_cap


def read_token():
    # This is the sole credential path this helper may read.
    token_path = Path.home() / ".config" / "agent" / "gateway.token"
    try:
        token = token_path.read_text(encoding="utf-8").strip()
    except OSError:
        fail("auth-unavailable")
    if not token or len(token) > 4096 or any(ch in token for ch in "\r\n\x00"):
        fail("auth-unavailable")
    return token


def main():
    model, messages, timeout, output_cap = read_request()
    token = read_token()
    payload = json.dumps({"model": model, "messages": messages, "stream": False}, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(gateway_url(), data=payload, method="POST", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        fail("gateway-unavailable")
    if len(raw) > MAX_RESPONSE_BYTES:
        fail("invalid-response")
    try:
        result = json.loads(raw.decode("utf-8"))
        choices = result["choices"]
        content = choices[0]["message"]["content"]
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError):
        fail("invalid-response")
    if not isinstance(content, str) or not content.strip() or "\x00" in content:
        fail("invalid-response")
    content = content.strip()
    if len(content) > output_cap:
        fail("output-limit")
    sys.stdout.write(content)


if __name__ == "__main__":
    # urllib owns the connection; default SIGTERM behavior stops it promptly.
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    main()
