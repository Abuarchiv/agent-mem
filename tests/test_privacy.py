from agent_mem.core import privacy

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


def test_passwords_given_as_command_line_options_are_redacted():
    from agent_mem.core.privacy import clean_text

    leaking = [
        "mysql -u root -pS3cr3tpw -h db",
        "mysqldump -pS3cr3tpw db",
        "psql --password S3cr3tpw",
        "sshpass -p S3cr3tpw ssh host",
        "curl -u admin:S3cr3tpw https://x.io",
        "docker login -u me -p S3cr3tpw",
        "redis-cli -a S3cr3tpw",
    ]
    for command in leaking:
        assert "S3cr3t" not in clean_text(command, 500), command
    untouched = [
        "mkdir -p src/pkg",
        "tar -pxf a.tar",
        "ssh -p 2222 host",
        "git push -u origin main",
        "mysql -p db",
        "date -u +%H:%M:%S",
    ]
    for command in untouched:
        assert clean_text(command, 500) == command


def test_quoted_passphrases_cookies_basic_auth_and_azure_keys_are_redacted():
    cases = {
        '{"password": "correct horse battery staple"}': "horse",
        "Cookie: session=8f14e45fceea167a5a36dedd4bea2543; theme=dark": "8f14e45f",
        "Authorization: Basic dXNlcjpzdXBlcnNlY3JldA==": "dXNlcjpz",
        "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IF==": "Eby8",
    }
    for text, secret in cases.items():
        assert secret not in privacy.clean_text(text, 1000), text
    for prose in ("the basic idea is simple", "cookie handling in browsers is tricky", '"password": "${DB_PASS}"'):
        assert privacy.clean_text(prose, 1000) == prose


def test_passwords_said_in_words_are_redacted():
    for text, secret in [
        ("Passwort: Sommer2026!", "Sommer2026"),
        ("mein passwort ist Sommer2026", "Sommer2026"),
        ("my password is hunter22x", "hunter22x"),
        ("Kennwort = abc12345", "abc12345"),
        ("the password for the db is Tr0ub4dor&3", "Tr0ub4dor"),
        ("Passwort lautet: blau-Haus-7", "blau-Haus"),
        ("aws secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"),
    ]:
        assert secret not in privacy.clean_text(text, 500), text
    for text in [
        "das Passwort ist nicht gesetzt",
        "the password is required",
        "password reset flow fixed",
        "pw = getpass()",
        "pw: $DB_PASS",
    ]:
        assert privacy.clean_text(text, 500) == text
