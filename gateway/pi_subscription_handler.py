"""LiteLLM custom provider that brokers a chat completion to Pi's Codex subscription.

This module intentionally has no provider credentials, request logging, or configurable
command execution.  The only executable and model are the locally installed Pi Codex
subscription client.
"""

import asyncio
import logging
import os
import signal
import time
from collections.abc import AsyncIterator, Iterator
from typing import Any

from litellm import CustomLLM
from litellm.llms.custom_llm import CustomLLMError
from litellm.types.utils import GenericStreamingChunk, ModelResponse

LOGGER = logging.getLogger("litellm.proxy.pi_subscription")

PI_BINARY = "/home/kyle/.nvm/versions/node/v24.15.0/bin/pi"
PI_MODEL = "openai-codex/gpt-5.6-sol"
# These public aliases are the only subscription profiles this handler can run.
# `coding-main` deliberately retains its historical implicit high effort behavior;
# evaluation aliases pin both model and effort for controlled comparisons.
SUBSCRIPTION_PROFILES = {
    "coding-main": (PI_MODEL, None),
    "mi-eval-luna-low": ("openai-codex/gpt-5.6-luna", "low"),
    "mi-eval-sol-low": ("openai-codex/gpt-5.6-sol", "low"),
    "mi-eval-terra-low": ("openai-codex/gpt-5.6-terra", "low"),
    "mi-eval-sol-medium": ("openai-codex/gpt-5.6-sol", "medium"),
    "mi-eval-sol-high": ("openai-codex/gpt-5.6-sol", "high"),
}
PI_HOME = "/home/kyle"
PI_AGENT_DIR = "/home/kyle/.pi/agent"
PI_WORKDIR = "/var/lib/llm-gateway"

MAX_MESSAGES = 32
MAX_INPUT_CHARS = 24_000
MAX_OUTPUT_CHARS = 12_000
MAX_STDERR_BYTES = 1_024
DEFAULT_TIMEOUT_SECONDS = 120
DEFAULT_CONCURRENCY = 2

# The subprocess receives this exact environment.  In particular it never inherits
# gateway URLs, gateway credentials, provider API keys, or request headers.
PI_ENV = {
    "HOME": PI_HOME,
    "LC_ALL": "C.UTF-8",
    "PATH": "/home/kyle/.nvm/versions/node/v24.15.0/bin:/usr/bin:/bin",
    "PI_CODING_AGENT_DIR": PI_AGENT_DIR,
    "PI_OFFLINE": "1",
    "TERM": "dumb",
}


class PiSubscriptionError(CustomLLMError):
    """A stable public error; details are deliberately never propagated."""


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if not isinstance(part, dict) or part.get("type") not in {"text", "input_text"}:
                raise PiSubscriptionError(400, "unsupported message content")
            text = part.get("text")
            if not isinstance(text, str):
                raise PiSubscriptionError(400, "unsupported message content")
            parts.append(text)
        return "".join(parts)
    raise PiSubscriptionError(400, "unsupported message content")


def serialize_messages(messages: Any) -> str:
    """Convert only bounded text chat messages to an unambiguous stable prompt."""
    if not isinstance(messages, list) or not messages or len(messages) > MAX_MESSAGES:
        raise PiSubscriptionError(400, "invalid message count")

    rendered: list[str] = [
        "You are a text-only assistant. Answer the role-labelled conversation directly. "
        "Do not invoke tools or perform external actions.\n"
    ]
    valid_roles = {"system", "developer", "user", "assistant", "tool"}
    for message in messages:
        if not isinstance(message, dict):
            raise PiSubscriptionError(400, "invalid message")
        role = message.get("role")
        if not isinstance(role, str) or role not in valid_roles:
            raise PiSubscriptionError(400, "invalid message role")
        text = _content_to_text(message.get("content"))
        rendered.append(f"\n[{role.upper()}]\n{text}\n[/{role.upper()}]\n")

    prompt = "".join(rendered)
    if len(prompt) > MAX_INPUT_CHARS:
        raise PiSubscriptionError(400, "input exceeds gateway limit")
    return prompt


def resolve_profile(model: Any, request_kwargs: dict[str, Any] | None = None) -> tuple[str, str | None]:
    """Resolve an immutable local alias; never accept caller-selected model/effort."""
    name = str(model or "")
    if name.startswith("pi-subscription/"):
        name = name.removeprefix("pi-subscription/")
    profile = SUBSCRIPTION_PROFILES.get(name)
    if profile is None:
        raise PiSubscriptionError(400, "unknown subscription profile")
    for key in ("thinking", "reasoning_effort", "effort"):
        if request_kwargs and request_kwargs.get(key) not in (None, ""):
            raise PiSubscriptionError(400, "subscription profile does not accept effort overrides")
    return profile


def _stderr_category(stderr: bytes) -> str:
    """Classify a bounded private diagnostic without ever returning or logging it."""
    text = stderr[:MAX_STDERR_BYTES].lower()
    if b"login" in text or b"auth" in text or b"unauthorized" in text:
        return "authentication"
    if b"rate limit" in text or b"too many requests" in text:
        return "rate_limited"
    return "subprocess"


async def _terminate(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(process.wait(), timeout=2)
    except asyncio.TimeoutError:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await process.wait()


async def _read_bounded(stream: asyncio.StreamReader, limit: int) -> tuple[bytes, bool]:
    chunks: list[bytes] = []
    size = 0
    overflow = False
    while True:
        chunk = await stream.read(4096)
        if not chunk:
            break
        remaining = limit - size
        if remaining > 0:
            chunks.append(chunk[:remaining])
            size += min(len(chunk), remaining)
        if len(chunk) > remaining:
            overflow = True
    return b"".join(chunks), overflow


class PiSubscriptionLLM(CustomLLM):
    def __init__(
        self,
        pi_path: str = PI_BINARY,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_concurrency: int = DEFAULT_CONCURRENCY,
    ) -> None:
        super().__init__()
        self._pi_path = pi_path
        self._timeout_seconds = timeout_seconds
        self._semaphore = asyncio.Semaphore(max_concurrency)

    async def _run(self, model: Any, messages: Any, request_kwargs: dict[str, Any] | None = None) -> str:
        prompt = serialize_messages(messages)
        inner_model, thinking = resolve_profile(model, request_kwargs)
        args = [
            self._pi_path,
            "--offline",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--no-tools",
            "--model",
            inner_model,
        ]
        if thinking:
            args.extend(["--thinking", thinking])
        args.extend(["--print", prompt])
        async with self._semaphore:
            process: asyncio.subprocess.Process | None = None
            stdout_task: asyncio.Task[tuple[bytes, bool]] | None = None
            stderr_task: asyncio.Task[tuple[bytes, bool]] | None = None
            try:
                process = await asyncio.create_subprocess_exec(
                    *args,
                    cwd=PI_WORKDIR,
                    env=PI_ENV,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    start_new_session=True,
                )
                assert process.stdout is not None and process.stderr is not None
                stdout_task = asyncio.create_task(
                    _read_bounded(process.stdout, MAX_OUTPUT_CHARS * 4 + 1)
                )
                stderr_task = asyncio.create_task(_read_bounded(process.stderr, MAX_STDERR_BYTES))
                await asyncio.wait_for(process.wait(), timeout=self._timeout_seconds)
                stdout, output_overflow = await stdout_task
                stderr, _ = await stderr_task
            except asyncio.TimeoutError as exc:
                if process is not None:
                    await _terminate(process)
                LOGGER.warning("pi_subscription_failure category=timeout")
                raise PiSubscriptionError(504, "subscription backend timed out") from exc
            except asyncio.CancelledError:
                if process is not None:
                    await _terminate(process)
                raise
            except OSError as exc:
                LOGGER.warning("pi_subscription_failure category=spawn")
                raise PiSubscriptionError(503, "subscription backend unavailable") from exc
            finally:
                if process is not None and process.returncode is None:
                    await _terminate(process)
                for task in (stdout_task, stderr_task):
                    if task is not None and not task.done():
                        task.cancel()

        if process.returncode != 0:
            LOGGER.warning(
                "pi_subscription_failure category=nonzero stderr_category=%s",
                _stderr_category(stderr),
            )
            raise PiSubscriptionError(502, "subscription backend failed")
        if output_overflow:
            LOGGER.warning("pi_subscription_failure category=output_limit")
            raise PiSubscriptionError(502, "subscription backend response exceeded limit")
        output = stdout.decode("utf-8", errors="replace").strip()
        if not output:
            LOGGER.warning("pi_subscription_failure category=empty")
            raise PiSubscriptionError(502, "subscription backend returned no content")
        if len(output) > MAX_OUTPUT_CHARS:
            LOGGER.warning("pi_subscription_failure category=output_limit")
            raise PiSubscriptionError(502, "subscription backend response exceeded limit")
        return output

    @staticmethod
    def _response(model: str, output: str, model_response: ModelResponse) -> ModelResponse:
        model_response.choices[0].message.content = output  # type: ignore[union-attr]
        model_response.choices[0].finish_reason = "stop"  # type: ignore[union-attr]
        model_response.created = int(time.time())
        model_response.model = model
        return model_response

    async def acompletion(self, model: str, messages: list, model_response: ModelResponse, **kwargs: Any) -> ModelResponse:
        return self._response(model, await self._run(model, messages, kwargs), model_response)

    def completion(self, model: str, messages: list, model_response: ModelResponse, **kwargs: Any) -> ModelResponse:
        return self._response(model, asyncio.run(self._run(model, messages, kwargs)), model_response)

    async def astreaming(self, model: str, messages: list, **kwargs: Any) -> AsyncIterator[GenericStreamingChunk]:
        output = await self._run(model, messages, kwargs)
        yield GenericStreamingChunk(
            text=output,
            is_finished=False,
            finish_reason="",
            usage=None,
            index=0,
            tool_use=None,
        )
        yield GenericStreamingChunk(
            text="",
            is_finished=True,
            finish_reason="stop",
            usage=None,
            index=0,
            tool_use=None,
        )

    def streaming(self, model: str, messages: list, **kwargs: Any) -> Iterator[GenericStreamingChunk]:
        output = asyncio.run(self._run(model, messages, kwargs))
        yield GenericStreamingChunk(output, False, "", None, 0, None)
        yield GenericStreamingChunk("", True, "stop", None, 0, None)


pi_subscription_llm = PiSubscriptionLLM()
