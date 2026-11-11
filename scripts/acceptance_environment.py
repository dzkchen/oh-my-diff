import os


PROVIDER_ENV_PREFIXES = ("OPENAI_", "ANTHROPIC_", "GOOGLE_", "GEMINI_", "AZURE_", "AWS_",
                         "MISTRAL_", "GROQ_", "CEREBRAS_", "DEEPSEEK_", "TOGETHER_",
                         "OPENROUTER_", "HF_")


def clean_environment(source=None):
    inherited = os.environ if source is None else source
    return {name: value for name, value in inherited.items()
            if not name.startswith(("CODEX_", "OMD_", *PROVIDER_ENV_PREFIXES))}


def isolated_environment(base, home, upstream, source=None):
    env = clean_environment(source)
    env.update(HOME=str(home), CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(home),
               TMPDIR=str(base), XDG_CONFIG_HOME=str(base / "xdg-config"),
               XDG_DATA_HOME=str(base / "xdg-data"), XDG_CACHE_HOME=str(base / "xdg-cache"))
    env["PATH"] = str(upstream.parent) + os.pathsep + env.get("PATH", "")
    return env
