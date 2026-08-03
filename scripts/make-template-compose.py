#!/usr/bin/env python3
# =============================================================================
#  Generate the self-contained Dokploy template (compose + template.toml mount).
# =============================================================================
#  Dokploy's template fetcher only downloads template.toml + docker-compose.yml
#  -- it NEVER fetches family.env or llm-chatter-settings.conf. So the published
#  template has to carry both some other way:
#
#    * family.env        -> the 51..N AC_* settings are INLINED into the
#                           worldserver's `environment:` block (they are env vars).
#    * llm-chatter-      -> a config FILE, not env vars, so it is shipped as a
#      settings.conf        Dokploy File Mount: a [[config.mounts]] block in
#                           template.toml (content embedded here) that Dokploy
#                           writes to its /files dir, which the compose mounts as
#                           ../files/llm-chatter-settings.conf.
#
#  This reads the repo-root stack and writes both files under
#  dokploy-template/blueprints/azeroth-family/. The root stack is never modified.
#  Behaviour is identical to a local deploy -- only the delivery mechanism changes.
#
#  Regenerate whenever family-settings.ini or llm-chatter-settings.conf changes:
#      python3 scripts/ini2env.py family-settings.ini > family.env
#      python3 scripts/make-template-compose.py
# =============================================================================
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_COMPOSE = ROOT / "docker-compose.yml"
FAMILY_ENV = ROOT / "family.env"
LLM_CONF = ROOT / "llm-chatter-settings.conf"
TEMPLATE_DIR = ROOT / "dokploy-template/blueprints/azeroth-family"
OUT_COMPOSE = TEMPLATE_DIR / "docker-compose.yml"
OUT_TOML = TEMPLATE_DIR / "template.toml"

WORLD_ID = "  ac-worldserver:"   # two-space indent => a top-level service key
ENV_FILE_KEY = "env_file:"        # the key we strip, inside the worldserver service

# The conf is mounted from Dokploy's /files dir. The repo-root compose mounts it
# as ./llm-chatter-settings.conf (next to the compose); the fetched template
# compose must reference the Dokploy-managed copy at ../files/ instead.
CONF_SOURCE = "./llm-chatter-settings.conf"
CONF_IN_TEMPLATE = "../files/llm-chatter-settings.conf"

# Delimiters around the generated mount block in template.toml.
MOUNT_BEGIN = "# >>> managed: llm-chatter-settings.conf mount (scripts/make-template-compose.py) >>>"
MOUNT_END = "# <<< managed: llm-chatter-settings.conf mount <<<"


def parse_family_env(path: Path) -> list[tuple[str, str]]:
    """Return (KEY, value) pairs from an env file, skipping comments/blanks."""
    entries: list[tuple[str, str]] = []
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        entries.append((key.strip(), value))
    return entries


def is_service_key(line: str) -> bool:
    """True for a two-space-indented service key like '  ac-worldserver:'."""
    return line.startswith("  ") and not line.startswith("   ") and len(line) > 2


def build_template_compose(
    compose_text: str, entries: list[tuple[str, str]]
) -> str:
    """Inline family.env into the worldserver environment block; drop env_file;
    repoint the llm-chatter-settings.conf mount at Dokploy's /files dir."""
    lines = compose_text.splitlines()
    out: list[str] = []
    in_worldserver = False
    injected = False
    i = 0
    while i < len(lines):
        line = lines[i]

        # Track which service we are inside. A 0-indent key closes any service;
        # a 2-indent key opens a new one.
        if line and not line.startswith((" ", "\t")):
            in_worldserver = False
        elif is_service_key(line):
            in_worldserver = line.rstrip() == WORLD_ID

        # Skip the env_file: block inside the worldserver service.
        if in_worldserver and line.strip() == ENV_FILE_KEY:
            i += 1
            while i < len(lines) and lines[i].startswith("      "):
                i += 1
            continue

        # Repoint the conf mount to the Dokploy-managed /files copy.
        if CONF_SOURCE in line:
            line = line.replace(CONF_SOURCE, CONF_IN_TEMPLATE)

        out.append(line)

        # Inject the inlined family settings once, at the end of the worldserver
        # environment block.
        if in_worldserver and not injected and "AC_PLAYERBOTS_DATABASE_INFO:" in line:
            for key, value in entries:
                out.append(f'      {key}: "{value}"')
            injected = True

        i += 1

    if not injected:
        sys.exit(
            "error: could not find the worldserver environment block to inline "
            "into -- has docker-compose.yml changed?"
        )
    return "\n".join(out) + "\n"


def build_mount_block(conf_content: str) -> str:
    """The [[config.mounts]] block for template.toml carrying the conf verbatim."""
    return (
        f"{MOUNT_BEGIN}\n"
        "# llm-chatter-settings.conf, shipped as a Dokploy File Mount. Dokploy\n"
        "# fetches only template.toml + docker-compose.yml, so the conf travels\n"
        "# here; Dokploy writes it to its /files dir, which docker-compose.yml\n"
        "# mounts as ../files/llm-chatter-settings.conf. Source of truth:\n"
        "# /llm-chatter-settings.conf (public -- no secrets; the API key for\n"
        "# whichever LLMChatter.Provider it names comes from OPENROUTER_API_KEY or\n"
        "# ANTHROPIC_API_KEY, the DB password from DB_ROOT_PASSWORD).\n"
        "[[config.mounts]]\n"
        'filePath = "llm-chatter-settings.conf"\n'
        "content = '''\n"
        f"{conf_content}\n"
        "'''\n"
        f"{MOUNT_END}"
    )


def refresh_mount_block(toml_text: str, conf_content: str) -> str:
    """Replace the managed block if present, else append it."""
    block = build_mount_block(conf_content)
    pattern = re.compile(
        re.escape(MOUNT_BEGIN) + r".*?" + re.escape(MOUNT_END), re.DOTALL
    )
    if pattern.search(toml_text):
        return pattern.sub(lambda _: block, toml_text)
    return toml_text.rstrip("\n") + "\n\n" + block + "\n"


def validate_conf(conf_content: str) -> None:
    """Guard the embedded conf: TOML literal strings forbid ''' and Dokploy
    interpolates ${...} inside mount content (which would silently mangle it)."""
    if "'''" in conf_content:
        sys.exit(
            "error: llm-chatter-settings.conf contains ''' -- cannot embed in a "
            "TOML literal string. Edit the conf or change the embedding strategy."
        )
    if "${" in conf_content:
        print(
            "warning: llm-chatter-settings.conf contains '${' -- Dokploy will "
            "interpolate it as a template variable. Remove it unless intended.",
            file=sys.stderr,
        )


def main() -> None:
    for required in (SRC_COMPOSE, FAMILY_ENV, LLM_CONF):
        if not required.is_file():
            sys.exit(f"error: {required.relative_to(ROOT)} not found")
    if not OUT_TOML.is_file():
        sys.exit(f"error: {OUT_TOML.relative_to(ROOT)} not found (template.toml is hand-edited)")

    entries = parse_family_env(FAMILY_ENV)
    if not entries:
        sys.exit(f"error: no KEY=VALUE entries parsed from {FAMILY_ENV.relative_to(ROOT)}")

    # 1. Template docker-compose.yml: inline family.env, drop env_file, repoint conf.
    result = build_template_compose(SRC_COMPOSE.read_text(), entries)
    OUT_COMPOSE.write_text(result)
    print(f"inlined {len(entries)} family settings -> {OUT_COMPOSE.relative_to(ROOT)}")

    # 2. template.toml: refresh the File Mount carrying llm-chatter-settings.conf.
    conf_content = LLM_CONF.read_text().strip()
    validate_conf(conf_content)
    new_toml = refresh_mount_block(OUT_TOML.read_text(), conf_content)
    OUT_TOML.write_text(new_toml)
    print(f"embedded llm-chatter-settings.conf ({len(conf_content.splitlines())} lines) -> {OUT_TOML.relative_to(ROOT)}")

    print("\nverify:")
    # No API key here on purpose: neither compose may make one mandatory, since
    # the bridge entrypoint -- not compose -- is what enforces the key matching
    # LLMChatter.Provider. A `:?` creeping back in would fail this line.
    print("  DB_ROOT_PASSWORD=x REALM_ADDRESS=100.0.0.0 \\")
    print("    docker compose -f dokploy-template/blueprints/azeroth-family/docker-compose.yml config --quiet")


if __name__ == "__main__":
    main()
