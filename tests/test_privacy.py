from agent_mem import privacy

# Fake credentials, assembled at runtime so that secret scanners do not flag this file.
_BODY = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
SECRETS = [
    "sk-" + "ant-api03-" + _BODY,
    "sk-" + "proj-" + _BODY,
    "gh" + "p_" + _BODY,
    "github" + "_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    "gl" + "pat-" + _BODY[:20],
    "xo" + "xb-1234567890-abcdefghijklmn",
    "sk" + "_live_" + _BODY[:24],
    "AI" + "za" + "SyA-1234567890abcdefghijklmnopqrstu",
    "AK" + "IA" + "ABCDEFGHIJKLMNOP",
    "np" + "m_" + _BODY,
    "h" + "f_" + _BODY[:33],
    "ey" + "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
]


def test_known_secret_formats_are_redacted():
    for secret in SECRETS:
        text, count = privacy.redact(f"token here: {secret} end")
        assert secret not in text, secret
        assert count >= 1


def test_private_key_block_is_redacted():
    block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"
    assert "MIIEpAIBAAKCAQEA" not in privacy.clean_text(f"key:\n{block}\n", 10_000)


def test_assignments_and_url_credentials():
    text = privacy.clean_text('password = "hunter2hunter2"\nDB=postgres://admin:s3cretpw@db.local/app', 1000)
    assert "hunter2hunter2" not in text
    assert "s3cretpw" not in text
    assert "db.local/app" in text


def test_harmless_assignments_are_kept():
    text = privacy.clean_text("max_tokens = 4096\napi_key: $API_KEY\ntoken_required = true", 1000)
    assert "4096" in text
    assert "$API_KEY" in text
    assert "true" in text


def test_private_sections_and_control_characters():
    text = privacy.clean_text("public <private>my secret plan</private> \x1b[31mred\x1b[0m", 1000)
    assert "my secret plan" not in text
    assert "\x1b" not in text
    assert "red" in text


def test_truncation_keeps_head_and_tail():
    text = privacy.truncate("a" * 1000 + "END", 100)
    assert len(text) <= 100
    assert text.endswith("END")


def test_denoise_keeps_error_lines():
    middle_error = "\n".join(
        [f"line {i}" for i in range(100)] + ["TypeError: bad thing"] + [f"x {i}" for i in range(100)]
    )
    assert "TypeError: bad thing" in privacy.denoise_output(middle_error, 3000)


def test_excluded_paths():
    globs = ["*.pem", ".env", ".env.*", "secrets/**", "**/secrets/**"]
    assert privacy.path_excluded("/repo/.env", globs)
    assert privacy.path_excluded("config/.env.local", globs)
    assert privacy.path_excluded("certs/server.pem", globs)
    assert privacy.path_excluded("secrets/prod.yaml", globs)
    assert privacy.path_excluded("app/secrets/prod.yaml", globs)
    assert not privacy.path_excluded("src/app.py", globs)
