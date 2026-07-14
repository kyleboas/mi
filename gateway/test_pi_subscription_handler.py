#!/usr/bin/env python3
"""Hermetic checks for the Pi subscription LiteLLM custom provider."""

import asyncio
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_handler():
    spec = importlib.util.spec_from_file_location("pi_subscription_handler_test", ROOT / "pi_subscription_handler.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


M = load_handler()


def assert_error(coro, status):
    try:
        asyncio.run(coro)
    except M.PiSubscriptionError as exc:
        assert exc.status_code == status, exc.status_code
        return str(exc)
    raise AssertionError("expected PiSubscriptionError")


def make_fake(directory: Path, log: Path) -> Path:
    fake = directory / "fake-pi.py"
    fake.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys, time\n"
        f"log = {str(log)!r}\n"
        "prompt = sys.argv[-1]\n"
        "with open(log, 'a', encoding='utf-8') as f:\n"
        "  f.write(json.dumps({'args': sys.argv[1:], 'env': sorted(os.environ), 'pid': os.getpid()}) + '\\n')\n"
        "if 'SLEEP' in prompt or 'CONCURRENCY' in prompt:\n"
        "  time.sleep(0.25)\n"
        "if 'FAIL' in prompt:\n"
        "  sys.stderr.write('authentication secret-marker\\n'); sys.exit(7)\n"
        "if 'EMPTY' in prompt:\n"
        "  sys.exit(0)\n"
        "if 'HUGE' in prompt:\n"
        "  sys.stdout.write('x' * 50000); sys.exit(0)\n"
        "sys.stdout.write('fake subscription response\\n')\n",
        encoding="utf-8",
    )
    fake.chmod(0o700)
    return fake


def response():
    from litellm.types.utils import ModelResponse

    return ModelResponse()


def messages(text="hello"):
    return [{"role": "system", "content": "rules"}, {"role": "user", "content": text}]


def test_serialization():
    prompt = M.serialize_messages(messages())
    assert "[SYSTEM]\nrules\n[/SYSTEM]" in prompt
    assert "[USER]\nhello\n[/USER]" in prompt
    assert M.serialize_messages([{"role": "user", "content": [{"type": "text", "text": "a"}, {"type": "input_text", "text": "b"}]}]).endswith("[USER]\nab\n[/USER]\n")
    assert_error(_invalid_role(), 400)
    assert_error(_too_large(), 400)


async def _invalid_role():
    M.serialize_messages([{"role": "unknown", "content": "x"}])


async def _too_large():
    M.serialize_messages([{"role": "user", "content": "x" * M.MAX_INPUT_CHARS}])


async def provider_checks(fake: Path, log: Path):
    handler = M.PiSubscriptionLLM(pi_path=str(fake), timeout_seconds=1, max_concurrency=1)
    result = await handler.acompletion("coding-main", messages(), response())
    assert result.choices[0].message.content == "fake subscription response"

    chunks = [chunk async for chunk in handler.astreaming("coding-main", messages())]
    assert [chunk["text"] for chunk in chunks] == ["fake subscription response", ""]
    assert chunks[-1]["is_finished"] and chunks[-1]["finish_reason"] == "stop"

    records = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
    expected_prefix = [
        "--offline", "--no-session", "--no-extensions", "--no-skills",
        "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
        "--model", M.PI_MODEL, "--print",
    ]
    assert records[0]["args"][:-1] == expected_prefix
    assert records[0]["env"] == sorted(M.PI_ENV), records[0]["env"]
    assert "OPENAI_BASE_URL" not in records[0]["env"]
    assert "LITELLM_MASTER_KEY" not in records[0]["env"]

    profile_expectations = {
        "mi-eval-luna-low": ("openai-codex/gpt-5.6-luna", "low"),
        "mi-eval-sol-low": ("openai-codex/gpt-5.6-sol", "low"),
        "mi-eval-terra-low": ("openai-codex/gpt-5.6-terra", "low"),
        "mi-eval-sol-high": ("openai-codex/gpt-5.6-sol", "high"),
    }
    for alias, (inner_model, thinking) in profile_expectations.items():
        await handler.acompletion(alias, messages(alias), response())
    records = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
    for record, (inner_model, thinking) in zip(records[2:], profile_expectations.values()):
        args = record["args"][:-1]
        assert args[-5:] == ["--model", inner_model, "--thinking", thinking, "--print"], args
    await assert_async_error(_unknown_profile(handler), 400)
    await assert_async_error(_effort_override(handler), 400)

    nonzero = await _capture_error(handler, "FAIL")
    assert nonzero.status_code == 502 and "secret-marker" not in str(nonzero)
    assert (await _capture_error(handler, "EMPTY")).status_code == 502
    assert (await _capture_error(handler, "HUGE")).status_code == 502

    timed = M.PiSubscriptionLLM(pi_path=str(fake), timeout_seconds=0.05, max_concurrency=1)
    assert (await _capture_error(timed, "SLEEP")).status_code == 504

    cancellable = M.PiSubscriptionLLM(pi_path=str(fake), timeout_seconds=1, max_concurrency=1)
    cancelled = asyncio.create_task(cancellable._run("coding-main", messages("SLEEP")))
    await asyncio.sleep(0.05)
    cancelled.cancel()
    try:
        await cancelled
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("cancelling a gateway request must cancel its Pi child")
    child_pid = json.loads(log.read_text(encoding="utf-8").splitlines()[-1])["pid"]
    await asyncio.sleep(0.1)
    try:
        os.kill(child_pid, 0)
    except ProcessLookupError:
        pass
    else:
        raise AssertionError("cancelled Pi child is still running")

    started = time.monotonic()
    await asyncio.gather(
        handler._run("coding-main", messages("CONCURRENCY one")),
        handler._run("coding-main", messages("CONCURRENCY two")),
    )
    assert time.monotonic() - started >= 0.45, "semaphore did not bound concurrent Pi children"


async def assert_async_error(coro, status):
    try:
        await coro
    except M.PiSubscriptionError as exc:
        assert exc.status_code == status, exc.status_code
        return str(exc)
    raise AssertionError("expected PiSubscriptionError")


async def _unknown_profile(handler):
    await handler.acompletion("mi-eval-arbitrary", messages(), response())


async def _effort_override(handler):
    await handler.acompletion("mi-eval-sol-low", messages(), response(), reasoning_effort="high")


async def _capture_error(handler, text):
    try:
        await handler._run("coding-main", messages(text))
    except M.PiSubscriptionError as exc:
        return exc
    raise AssertionError("expected custom provider failure")


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_proxy_authentication(fake: Path, log: Path):
    """The actual LiteLLM config path still requires the master key."""
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        shutil.copy2(ROOT / "pi_subscription_handler.py", directory / "pi_subscription_handler.py")
        (directory / "test_handler.py").write_text(
            "from pi_subscription_handler import PiSubscriptionLLM\n"
            f"pi_subscription_llm = PiSubscriptionLLM(pi_path={str(fake)!r}, timeout_seconds=1)\n",
            encoding="utf-8",
        )
        config = directory / "config.yaml"
        config.write_text(
            textwrap.dedent(
                """\
                model_list:
                  - model_name: coding-main
                    litellm_params:
                      model: pi-subscription/coding-main
                      api_key: ""
                litellm_settings:
                  telemetry: false
                  custom_provider_map:
                    - provider: pi-subscription
                      custom_handler: test_handler.pi_subscription_llm
                general_settings:
                  master_key: test-master
                """
            ),
            encoding="utf-8",
        )
        port = free_port()
        process = subprocess.Popen(
            ["/opt/litellm/bin/litellm", "--config", str(config), "--host", "127.0.0.1", "--port", str(port)],
            cwd=directory,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 40
            url = f"http://127.0.0.1:{port}/v1/chat/completions"
            payload = json.dumps({"model": "coding-main", "messages": messages()}).encode()
            fake_calls_before = len(log.read_text(encoding="utf-8").splitlines())
            last_status = None
            while True:
                try:
                    request = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
                    with urllib.request.urlopen(request, timeout=1) as unauthenticated:
                        last_status = unauthenticated.status
                except urllib.error.HTTPError as exc:
                    last_status = exc.code
                    # LiteLLM 1.92 maps a rejected master key to 500 when
                    # its optional Prisma module is absent. It still rejects
                    # before the provider call, which is the security property.
                    if exc.code in {401, 403, 500}:
                        break
                except urllib.error.URLError:
                    pass
                if time.monotonic() >= deadline:
                    raise AssertionError(f"LiteLLM proxy did not require authentication (status={last_status}, exit={process.poll()})")
                time.sleep(0.1)

            assert len(log.read_text(encoding="utf-8").splitlines()) == fake_calls_before, "unauthenticated call reached Pi"

            request = urllib.request.Request(
                url,
                data=payload,
                headers={"Content-Type": "application/json", "Authorization": "Bearer test-master"},
            )
            with urllib.request.urlopen(request, timeout=10) as reply:
                body = json.loads(reply.read())
            assert body["choices"][0]["message"]["content"] == "fake subscription response"

            stream_payload = json.dumps({"model": "coding-main", "messages": messages(), "stream": True}).encode()
            stream_request = urllib.request.Request(
                url,
                data=stream_payload,
                headers={"Content-Type": "application/json", "Authorization": "Bearer test-master"},
            )
            with urllib.request.urlopen(stream_request, timeout=10) as reply:
                stream_body = reply.read().decode("utf-8")
            assert "fake subscription response" in stream_body
            assert "data: [DONE]" in stream_body
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def main():
    test_serialization()
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        log = directory / "fake.log"
        fake = make_fake(directory, log)
        asyncio.run(provider_checks(fake, log))
        test_proxy_authentication(fake, log)
    print("pi subscription gateway tests passed")


if __name__ == "__main__":
    main()
