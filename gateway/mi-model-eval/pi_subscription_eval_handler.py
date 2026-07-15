"""Temporary, explicit Mi model-evaluation profiles for the local gateway."""

from pi_subscription_handler import PiSubscriptionLLM, SUBSCRIPTION_PROFILES

EVAL_PROFILES = {
    "mi-eval-luna-low": ("openai-codex/gpt-5.6-luna", "low"),
    "mi-eval-sol-low": ("openai-codex/gpt-5.6-sol", "low"),
    "mi-eval-sol-medium": ("openai-codex/gpt-5.6-sol", "medium"),
    "mi-eval-terra-low": ("openai-codex/gpt-5.6-terra", "low"),
    "mi-eval-sol-high": ("openai-codex/gpt-5.6-sol", "high"),
}

pi_subscription_llm = PiSubscriptionLLM(profiles={**SUBSCRIPTION_PROFILES, **EVAL_PROFILES})
